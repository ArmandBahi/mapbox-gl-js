// @flow

import Texture from '../../src/render/texture.js';
import Framebuffer from '../../src/gl/framebuffer.js';
import ColorMode from '../../src/gl/color_mode.js';
import DepthMode from '../../src/gl/depth_mode.js';
import StencilMode from '../../src/gl/stencil_mode.js';
import CullFaceMode from '../../src/gl/cull_face_mode.js';
import Transform from '../../src/geo/transform.js';
import {Frustum} from '../../src/util/primitives.js';
import Style from '../../src/style/style.js';
import Color from '../../src/style-spec/util/color.js';
import {FreeCamera} from '../../src/ui/free_camera.js';
import {OverscaledTileID, UnwrappedTileID} from '../../src/source/tile_id.js';
import Painter from '../../src/render/painter.js';
import Program from '../../src/render/program.js';
import type {UniformValues} from '../../src/render/uniform_binding.js';
import {mercatorZfromAltitude} from '../../src/geo/mercator_coordinate.js';
import {cartesianPositionToSpherical, sphericalPositionToCartesian, clamp, linearVec3TosRGB} from '../../src/util/util.js';

import type {LightProps as Directional} from '../style/directional_light_properties.js';
import type {LightProps as Ambient} from '../style/ambient_light_properties.js';
import Lights from '../style/lights.js';
import {defaultShadowUniformValues} from '../render/shadow_uniforms.js';
import type {ShadowUniformsType} from '../render/shadow_uniforms.js';
import TextureSlots from './texture_slots.js';

import assert from 'assert';

import {mat4, vec3} from 'gl-matrix';
import type {Mat4, Vec3} from 'gl-matrix';
import {groundShadowUniformValues} from './program/ground_shadow_program.js';

type ShadowCascade = {
    framebuffer: Framebuffer,
    texture: Texture,
    matrix: Mat4,
    far: number,
    frustum: Frustum
};

const cascadeCount = 2;
const shadowMapResolution = 2048;

export class ShadowRenderer {
    painter: Painter;
    _enabled: boolean;
    _shadowLayerCount: number;
    _cascades: Array<ShadowCascade>;
    _depthMode: DepthMode;
    _uniformValues: UniformValues<ShadowUniformsType>;

    constructor(painter: Painter) {
        this.painter = painter;
        this._enabled = false;
        this._shadowLayerCount = 0;
        this._cascades = [];
        this._depthMode = new DepthMode(painter.context.gl.LEQUAL, DepthMode.ReadWrite, [0, 1]);
        this._uniformValues = defaultShadowUniformValues();
    }

    destroy() {
        for (const cascade of this._cascades) {
            cascade.texture.destroy();
            cascade.framebuffer.destroy();
        }

        this._cascades = [];
    }

    updateShadowParameters(transform: Transform, directionalLight: ?Lights<Directional>) {
        const painter = this.painter;

        this._enabled = false;
        this._shadowLayerCount = 0;

        if (!painter.context.isWebGL2 || !directionalLight || !directionalLight.properties) {
            return;
        }

        const shadowIntensity = directionalLight.properties.get('shadow-intensity');

        if (directionalLight.properties.get('cast-shadows') !== true || shadowIntensity <= 0.0) {
            return;
        }

        this._shadowLayerCount = painter.style.order.reduce(
            (accumulator: number, layerId: string) => {
                const layer = painter.style._layers[layerId];
                return accumulator + (layer.hasShadowPass() && !layer.isHidden(transform.zoom) ? 1 : 0);
            }, 0);

        this._enabled = this._shadowLayerCount > 0;

        if (!this._enabled) {
            return;
        }

        const context = painter.context;
        const width = shadowMapResolution;
        const height = shadowMapResolution;

        if (this._cascades.length === 0) {
            for (let i = 0; i < cascadeCount; ++i) {
                const useColor = painter._shadowMapDebug;

                const gl = context.gl;
                const fbo = context.createFramebuffer(width, height, useColor, 'texture');
                const depthTexture = new Texture(context, {width, height, data: null}, gl.DEPTH_COMPONENT);
                fbo.depthAttachment.set(depthTexture.texture);

                if (useColor) {
                    const colorTexture = new Texture(context, {width, height, data: null}, gl.RGBA);
                    fbo.colorAttachment.set(colorTexture.texture);
                }

                this._cascades.push({framebuffer: fbo, texture: depthTexture, matrix: mat4.create(), far: 0, frustum: new Frustum([[]], [[]])});
            }
        }

        const shadowDirection = shadowDirectionFromProperties(transform, directionalLight);
        let verticalRange = 0.0;
        if (transform.elevation) {
            const elevation = transform.elevation;
            const range = [10000, -10000];
            elevation.visibleDemTiles.filter(tile => tile.dem).forEach(tile => {
                const minMaxTree = (tile.dem: any).tree;
                range[0] = Math.min(range[0], minMaxTree.minimums[0]);
                range[1] = Math.max(range[1], minMaxTree.maximums[0]);
            });
            if (range[0] !== 10000) {
                verticalRange = (range[1] - range[0]) * elevation.exaggeration();
            }
        }

        const cascadeSplitDist = transform.cameraToCenterDistance * 1.5;
        const shadowCutoutDist = cascadeSplitDist * 3.0;
        const cameraInvProj = new Float64Array(16);
        for (let cascadeIndex = 0; cascadeIndex < cascadeCount; ++cascadeIndex) {
            const cascade = this._cascades[cascadeIndex];

            let near = transform.height / 50.0;
            let far = 1.0;

            if (cascadeCount === 1) {
                far = shadowCutoutDist;
            } else {
                if (cascadeIndex === 0) {
                    far = cascadeSplitDist;
                } else {
                    near = cascadeSplitDist;
                    far = shadowCutoutDist;
                }
            }

            cascade.matrix = createLightMatrix(transform, shadowDirection, near, far, shadowMapResolution, verticalRange);

            mat4.invert(cameraInvProj, cascade.matrix);
            cascade.frustum = Frustum.fromInvProjectionMatrix(cameraInvProj, 1, 0, true);
            cascade.far = far;
        }
        this._uniformValues['u_fade_range'] = [this._cascades[1].far * 0.75, this._cascades[1].far];
        this._uniformValues['u_shadow_intensity'] = shadowIntensity;
        this._uniformValues['u_shadow_direction'] = [shadowDirection[0], shadowDirection[1], shadowDirection[2]];
        this._uniformValues['u_texel_size'] = 1 / shadowMapResolution;
        this._uniformValues['u_shadowmap_0'] = TextureSlots.ShadowMap0;
        this._uniformValues['u_shadowmap_1'] = TextureSlots.ShadowMap0 + 1;
    }

    get enabled(): boolean {
        return this._enabled;
    }

    set enabled(enabled: boolean) {
        // called on layer rendering to disable shadow receiving.
        this._enabled = enabled;
    }

    drawShadowPass(style: Style, sourceCoords: {[_: string]: Array<OverscaledTileID>}) {
        if (!this._enabled) {
            return;
        }

        const painter = this.painter;
        const context = painter.context;

        assert(painter.renderPass === 'shadow');

        context.viewport.set([0, 0, shadowMapResolution, shadowMapResolution]);

        for (let cascade = 0; cascade < cascadeCount; ++cascade) {
            painter.currentShadowCascade = cascade;

            context.bindFramebuffer.set(this._cascades[cascade].framebuffer.framebuffer);
            context.clear({color: Color.white, depth: 1});

            for (const layerId of style.order) {
                const layer = style._layers[layerId];
                if (!layer.hasShadowPass() || layer.isHidden(painter.transform.zoom)) continue;

                const sourceCache = style._getLayerSourceCache(layer);
                const coords = sourceCache ? sourceCoords[sourceCache.id] : undefined;
                if (layer.type !== 'model' && !(coords && coords.length)) continue;

                painter.renderLayer(painter, sourceCache, layer, coords);
            }
        }

        painter.currentShadowCascade = 0;
    }

    drawGroundShadows() {
        if (!this._enabled) {
            return;
        }

        const painter = this.painter;
        const style = painter.style;
        const context = painter.context;
        const directionalLight = style.directionalLight;
        const ambientLight = style.ambientLight;

        if (!directionalLight || !ambientLight) {
            return;
        }

        const program = painter.useProgram('groundShadow');

        // Render shadows on the ground plane as an extra layer of blended "tiles"
        const tileCoverOptions = {
            tileSize: 512,
            renderWorldCopies: true
        };
        const tiles = painter.transform.coveringTiles(tileCoverOptions);

        const shadowColor = calculateGroundShadowFactor(directionalLight, ambientLight);

        const depthMode = new DepthMode(context.gl.LEQUAL, DepthMode.ReadWrite, painter.depthRangeFor3D);

        for (const id of tiles) {
            const unwrapped = id.toUnwrapped();

            this.setupShadows(unwrapped, program);

            painter.uploadCommonUniforms(context, program, unwrapped);

            const uniformValues = groundShadowUniformValues(painter.transform.calculateProjMatrix(unwrapped), shadowColor);

            program.draw(painter, context.gl.TRIANGLES, depthMode, StencilMode.disabled, ColorMode.multiply, CullFaceMode.disabled,
                uniformValues, "ground_shadow", painter.tileExtentBuffer, painter.quadTriangleIndexBuffer,
                painter.tileExtentSegments, {}, painter.transform.zoom,
                null, null);
        }
    }

    getShadowPassColorMode(): $ReadOnly<ColorMode> {
        return this.painter._shadowMapDebug ? ColorMode.unblended : ColorMode.disabled;
    }

    getShadowPassDepthMode(): $ReadOnly<DepthMode> {
        return this._depthMode;
    }

    getShadowCastingLayerCount(): number {
        return this._shadowLayerCount;
    }

    calculateShadowPassMatrixFromTile(unwrappedId: UnwrappedTileID): Float32Array {
        const tr = this.painter.transform;
        const tileMatrix = tr.calculatePosMatrix(unwrappedId, tr.worldSize);
        const lightMatrix = this._cascades[this.painter.currentShadowCascade].matrix;
        mat4.multiply(tileMatrix, lightMatrix, tileMatrix);
        return Float32Array.from(tileMatrix);
    }

    calculateShadowPassMatrixFromMatrix(matrix: Mat4): Float32Array {
        const lightMatrix = this._cascades[this.painter.currentShadowCascade].matrix;
        mat4.multiply(matrix, lightMatrix, matrix);
        return Float32Array.from(matrix);
    }

    setupShadows(unwrappedTileID: UnwrappedTileID, program: Program<*>) {
        if (!this._enabled) {
            return;
        }

        const transform = this.painter.transform;
        const context = this.painter.context;
        const gl = context.gl;
        const uniforms = this._uniformValues;

        const lightMatrix = new Float64Array(16);
        const tileMatrix = transform.calculatePosMatrix(unwrappedTileID, transform.worldSize);

        for (let i = 0; i < cascadeCount; i++) {
            mat4.multiply(lightMatrix, this._cascades[i].matrix, tileMatrix);
            uniforms[i === 0 ? 'u_light_matrix_0' : 'u_light_matrix_1'] = Float32Array.from(lightMatrix);
            context.activeTexture.set(gl.TEXTURE0 + TextureSlots.ShadowMap0 + i);
            this._cascades[i].texture.bind(gl.NEAREST, gl.CLAMP_TO_EDGE);
        }

        program.setShadowUniformValues(context, uniforms);
    }

    setupShadowsFromMatrix(worldMatrix: Mat4, program: Program<*>) {
        if (!this._enabled) {
            return;
        }
        const context = this.painter.context;
        const gl = context.gl;
        const uniforms = this._uniformValues;
        const lightMatrix = new Float64Array(16);
        for (let i = 0; i < cascadeCount; i++) {
            mat4.multiply(lightMatrix, this._cascades[i].matrix, worldMatrix);
            uniforms[i === 0 ? 'u_light_matrix_0' : 'u_light_matrix_1'] = Float32Array.from(lightMatrix);
            context.activeTexture.set(gl.TEXTURE0 + TextureSlots.ShadowMap0 + i);
            this._cascades[i].texture.bind(gl.NEAREST, gl.CLAMP_TO_EDGE);
        }
        program.setShadowUniformValues(context, uniforms);
    }

    // When the same uniform values are used multiple times on different programs, it is sufficient
    // to call program.setShadowUniformValues(context, uniforms) instead of calling setupShadowsFromMatrix multiple times.
    getShadowUniformValues(): UniformValues<ShadowUniformsType> {
        return this._uniformValues;
    }

    getCurrentCascadeFrustum(): Frustum {
        return this._cascades[this.painter.currentShadowCascade].frustum;
    }
}

function shadowDirectionFromProperties(transform: Transform, directionalLight: Lights<Directional>): Vec3 {
    const direction = directionalLight.properties.get('direction');
    const spherical = cartesianPositionToSpherical(direction.x, direction.y, direction.z);

    // Limit light position specifically for shadow rendering.
    // If the polar coordinate goes very high, we get visual artifacts.
    // We limit the position in order to avoid these issues.
    // 75 degrees is an arbitrarily chosen value, based on a subjective assessment of the visuals.
    const MaxPolarCoordinate = 75.0;
    spherical[2] = clamp(spherical[2], 0.0, MaxPolarCoordinate);

    const position = sphericalPositionToCartesian([spherical[0], spherical[1], spherical[2]]);

    // Convert polar and azimuthal to cartesian
    return vec3.fromValues(position.x, position.y, position.z);
}

export function calculateGroundShadowFactor(directionalLight: Lights<Directional>, ambientLight: Lights<Ambient>): [number, number, number] {
    const dirColor = directionalLight.properties.get('color');
    const dirIntensity = directionalLight.properties.get('intensity');
    const dirDirection = directionalLight.properties.get('direction');
    const directionVec = [dirDirection.x, dirDirection.y, dirDirection.z];
    const ambientColor = ambientLight.properties.get('color');
    const ambientIntensity = ambientLight.properties.get('intensity');

    const groundNormal = [0.0, 0.0, 1.0];
    const dirDirectionalFactor = Math.max(vec3.dot(groundNormal, directionVec), 0.0);
    const ambStrength = [0, 0, 0];
    vec3.scale(ambStrength, ambientColor.toArray01Linear().slice(0, 3), ambientIntensity);
    const dirStrength = [0, 0, 0];
    vec3.scale(dirStrength, dirColor.toArray01Linear().slice(0, 3), dirDirectionalFactor * dirIntensity);

    // Multiplier X to get from lit surface color L to shadowed surface color S
    // X = A / (A + D)
    // A: Ambient light coming into the surface; taking into account color and intensity
    // D: Directional light coming into the surface; taking into account color, intensity and direction
    const shadow = [
        ambStrength[0] > 0.0 ? ambStrength[0] / (ambStrength[0] + dirStrength[0] + 1e-5) : 0.0,
        ambStrength[1] > 0.0 ? ambStrength[1] / (ambStrength[1] + dirStrength[1] + 1e-5) : 0.0,
        ambStrength[2] > 0.0 ? ambStrength[2] / (ambStrength[2] + dirStrength[2] + 1e-5) : 0.0
    ];

    // Because blending will happen in sRGB space, convert the shadow factor to sRGB
    return linearVec3TosRGB(shadow);
}

function createLightMatrix(
    transform: Transform,
    shadowDirection: Vec3,
    near: number,
    far: number,
    resolution: number,
    verticalRange: number): Float64Array {
    const zoom = transform.zoom;
    const scale = transform.scale;
    const ws = transform.worldSize;
    const wsInverse = 1.0 / ws;

    // Find the minimum shadow cascade bounding sphere to create a rotation invariant shadow volume
    // https://lxjk.github.io/2017/04/15/Calculate-Minimal-Bounding-Sphere-of-Frustum.html
    const aspectRatio = transform.aspect;
    const k = Math.sqrt(1. + aspectRatio * aspectRatio) * Math.tan(transform.fovX * 0.5);
    const k2 = k * k;
    const farMinusNear = far - near;
    const farPlusNear = far + near;

    let centerDepth;
    let radius;
    if (k2 > farMinusNear / farPlusNear) {
        centerDepth = far;
        radius = far * k;
    } else {
        centerDepth = 0.5 * farPlusNear * (1. + k2);
        radius = 0.5 * Math.sqrt(farMinusNear * farMinusNear + 2. * (far * far + near * near) * k2 + farPlusNear * farPlusNear * k2 * k2);
    }

    const pixelsPerMeter = transform.projection.pixelsPerMeter(transform.center.lat, ws);
    const cameraToWorldMerc = transform._camera.getCameraToWorldMercator();
    const sphereCenter = [0.0, 0.0, -centerDepth * wsInverse];
    vec3.transformMat4(sphereCenter, sphereCenter, cameraToWorldMerc);
    let sphereRadius = radius * wsInverse;

    // Transform frustum bounds to mercator space
    const frustumPointToMercator = function(point: Vec3): Vec3 {
        point[0] /= scale;
        point[1] /= scale;
        point[2] = mercatorZfromAltitude(point[2], transform._center.lat);
        return point;
    };

    // Check if we have padding we need to recalculate radii
    const padding = transform._edgeInsets;

    // If there is padding
    if (padding.left !== 0 || padding.top !== 0 || padding.right !== 0 || padding.bottom !== 0) {
        // and the padding is not symmetrical
        if (padding.left !== padding.right || padding.top !== padding.bottom) {
            const zUnit = transform.projection.zAxisUnit === "meters" ? pixelsPerMeter : 1.0;
            const worldToCamera = transform._camera.getWorldToCamera(transform.worldSize, zUnit);
            const cameraToClip = transform._camera.getCameraToClipPerspective(transform._fov, transform.width / transform.height, near, far);

            // Apply center of perspective offset
            cameraToClip[8] = -transform.centerOffset.x * 2 / transform.width;
            cameraToClip[9] = transform.centerOffset.y * 2 / transform.height;

            const cameraProj = new Float64Array(16);
            mat4.mul(cameraProj, cameraToClip, worldToCamera);

            const cameraInvProj = new Float64Array(16);
            mat4.invert(cameraInvProj, cameraProj);

            const frustum = Frustum.fromInvProjectionMatrix(cameraInvProj, ws, zoom, true);

            // Iterate over the frustum points to get the furthest one from the center
            for (const p of frustum.points) {
                const fp = frustumPointToMercator(p);
                sphereRadius = Math.max(sphereRadius, vec3.len(vec3.subtract([], sphereCenter, fp)));
            }
        }
    }

    const roundingMarginFactor = resolution / (resolution - 1.0);
    sphereRadius *= roundingMarginFactor;

    const pitch = Math.acos(shadowDirection[2]);
    const bearing = Math.atan2(-shadowDirection[0], -shadowDirection[1]);

    const camera = new FreeCamera();
    camera.position = sphereCenter;
    camera.setPitchBearing(pitch, bearing);

    // Construct the light view matrix
    const lightWorldToView = camera.getWorldToCamera(ws, pixelsPerMeter);

    // The lightMatrixNearZ value is a bit arbitrary. Its magnitude needs to be high enough to fit features that would
    // cast shadows into the view, but low enough to preserve depth precision in the shadow map.
    // The mercatorZfromZoom term gets used for the first cascade when zoom level is very high.
    // The radius term gets used for the second cascade in most cases and for the first cascade at lower zoom levels.
    const radiusPx = sphereRadius * ws;
    const lightMatrixNearZ = Math.min(transform._mercatorZfromZoom(17) * ws * -2.0, radiusPx * -2.0);

    const lightViewToClip = camera.getCameraToClipOrthographic(-radiusPx, radiusPx, -radiusPx, radiusPx, lightMatrixNearZ, (radiusPx + verticalRange * pixelsPerMeter) / shadowDirection[2]);
    const lightWorldToClip = new Float64Array(16);
    mat4.multiply(lightWorldToClip, lightViewToClip, lightWorldToView);

    // Move light camera in discrete steps in order to remove shimmering when translating
    const alignedCenter = vec3.fromValues(Math.floor(sphereCenter[0] * 1e6) / 1e6 * ws, Math.floor(sphereCenter[1] * 1e6) / 1e6 * ws, 0.);

    const halfResolution = 0.5 * resolution;
    const projectedPoint = [0.0, 0.0, 0.0];
    vec3.transformMat4(projectedPoint, alignedCenter, lightWorldToClip);
    vec3.scale(projectedPoint, projectedPoint, halfResolution);

    const roundedPoint = [Math.floor(projectedPoint[0]), Math.floor(projectedPoint[1]), Math.floor(projectedPoint[2])];
    const offsetVec = [0.0, 0.0, 0.0];
    vec3.sub(offsetVec, projectedPoint, roundedPoint);
    vec3.scale(offsetVec, offsetVec, -1.0 / halfResolution);

    const truncMatrix = new Float64Array(16);
    mat4.identity(truncMatrix);
    mat4.translate(truncMatrix, truncMatrix, offsetVec);
    mat4.multiply(lightWorldToClip, truncMatrix, lightWorldToClip);

    return lightWorldToClip;
}
