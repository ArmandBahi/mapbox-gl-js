// @flow

import type Painter from '../../src/render/painter.js';
import type SourceCache from '../../src/source/source_cache.js';
import type ModelStyleLayer from '../style/style_layer/model_style_layer.js';

import {modelUniformValues} from './program/model_program.js';
import type {Mesh, Node} from '../data/model.js';
import type {DynamicDefinesType} from '../../src/render/program/program_uniforms.js';

import Transform from '../../src/geo/transform.js';
import EXTENT from '../../src/data/extent.js';
import StencilMode from '../../src/gl/stencil_mode.js';
import ColorMode from '../../src/gl/color_mode.js';
import DepthMode from '../../src/gl/depth_mode.js';
import CullFaceMode from '../../src/gl/cull_face_mode.js';
import {mat4, vec3} from 'gl-matrix';
import type {Mat4} from 'gl-matrix';
import {getMetersPerPixelAtLatitude} from '../../src/geo/mercator_coordinate.js';
import TextureSlots from './texture_slots.js';
import {convertModelMatrixForGlobe} from '../util/model_util.js';
import {warnOnce} from '../../src/util/util.js';
import ModelBucket from '../data/bucket/model_bucket.js';
import assert from 'assert';
import {DEMSampler} from '../../src/terrain/elevation.js';
import {OverscaledTileID} from '../../src/source/tile_id.js';

export default drawModels;

type ModelParameters = {
    zScaleMatrix: Mat4;
    negCameraPosMatrix: Mat4;
}

type SortedMesh = {
    mesh: Mesh;
    depth: number;
    modelIndex: number;
    worldViewProjection: Mat4;
    nodeModelMatrix: Mat4;
}

function fogMatrixForModel(modelMatrix: Mat4, transform: Transform): Mat4 {
    // convert model matrix from the default world size to the one used by the fog
    const fogMatrix = [...modelMatrix];
    const scale = transform.cameraWorldSizeForFog / transform.worldSize;
    const scaleMatrix = mat4.identity([]);
    mat4.scale(scaleMatrix, scaleMatrix, [scale, scale, 1]);
    mat4.multiply(fogMatrix, scaleMatrix, fogMatrix);
    mat4.multiply(fogMatrix, transform.worldToFogMatrix, fogMatrix);
    return fogMatrix;
}

// Collect defines and dynamic buffers (colors, normals, uv) and bind textures. Used for single mesh and instanced draw.
function setupMeshDraw(definesValues, dynamicBuffers, mesh, painter) {
    const material = mesh.material;
    const pbr = material.pbrMetallicRoughness;
    const context = painter.context;

    // Textures
    if (pbr.baseColorTexture) {
        definesValues.push('HAS_TEXTURE_u_baseColorTexture');
        context.activeTexture.set(context.gl.TEXTURE0 + TextureSlots.BaseColor);
        const sampler = pbr.baseColorTexture.sampler;
        if (pbr.baseColorTexture.gfxTexture) {
            pbr.baseColorTexture.gfxTexture.bindExtraParam(sampler.minFilter, sampler.magFilter, sampler.wrapS, sampler.wrapT);
        }
    }

    if (pbr.metallicRoughnessTexture) {
        definesValues.push('HAS_TEXTURE_u_metallicRoughnessTexture');
        context.activeTexture.set(context.gl.TEXTURE0 + TextureSlots.MetallicRoughness);
        const sampler = pbr.metallicRoughnessTexture.sampler;
        if (pbr.metallicRoughnessTexture.gfxTexture) {
            pbr.metallicRoughnessTexture.gfxTexture.bindExtraParam(sampler.minFilter, sampler.magFilter, sampler.wrapS, sampler.wrapT);
        }
    }

    if (material.normalTexture) {
        definesValues.push('HAS_TEXTURE_u_normalTexture');
        context.activeTexture.set(context.gl.TEXTURE0 + TextureSlots.Normal);
        const sampler = material.normalTexture.sampler;
        if (material.normalTexture.gfxTexture) {
            material.normalTexture.gfxTexture.bindExtraParam(sampler.minFilter, sampler.magFilter, sampler.wrapS, sampler.wrapT);
        }
    }

    if (material.occlusionTexture) {
        definesValues.push('HAS_TEXTURE_u_occlusionTexture');
        context.activeTexture.set(context.gl.TEXTURE0 + TextureSlots.Occlusion);
        const sampler = material.occlusionTexture.sampler;
        if (material.occlusionTexture.gfxTexture) {
            material.occlusionTexture.gfxTexture.bindExtraParam(sampler.minFilter, sampler.magFilter, sampler.wrapS, sampler.wrapT);
        }
    }

    if (material.emissionTexture) {
        definesValues.push('HAS_TEXTURE_u_emissionTexture');
        context.activeTexture.set(context.gl.TEXTURE0 + TextureSlots.Emission);
        const sampler = material.emissionTexture.sampler;
        if (material.emissionTexture.gfxTexture) {
            material.emissionTexture.gfxTexture.bindExtraParam(sampler.minFilter, sampler.magFilter, sampler.wrapS, sampler.wrapT);
        }
    }

    if (mesh.texcoordBuffer) {
        definesValues.push('HAS_ATTRIBUTE_a_uv_2f');
        dynamicBuffers.push(mesh.texcoordBuffer);
    }
    if (mesh.colorBuffer) {
        const colorDefine = (mesh.colorBuffer.itemSize === 12) ? 'HAS_ATTRIBUTE_a_color_3f' : 'HAS_ATTRIBUTE_a_color_4f';
        definesValues.push(colorDefine);
        dynamicBuffers.push(mesh.colorBuffer);
    }
    if (mesh.normalBuffer) {
        definesValues.push('HAS_ATTRIBUTE_a_normal_3f');
        dynamicBuffers.push(mesh.normalBuffer);
    }

    if (material.alphaMode === 'OPAQUE' || material.alphaMode === 'MASK') {
        definesValues.push('UNPREMULT_TEXTURE_IN_SHADER');
    }

    // just to make the rendertests the same than native
    if (!material.defined) {
        definesValues.push('DIFFUSE_SHADED');
    }

    definesValues.push('USE_STANDARD_DERIVATIVES');
}

function drawMesh(sortedMesh: SortedMesh, painter: Painter, layer: ModelStyleLayer, modelParameters: ModelParameters, stencilMode, colorMode) {
    const opacity = layer.paint.get('model-opacity');
    assert(opacity > 0);
    const context = painter.context;
    const depthMode = new DepthMode(painter.context.gl.LEQUAL, DepthMode.ReadWrite, painter.depthRangeFor3D);

    const mesh = sortedMesh.mesh;
    const material = mesh.material;
    const pbr = material.pbrMetallicRoughness;

    let lightingMatrix;
    if (painter.transform.projection.zAxisUnit === "pixels") {
        lightingMatrix = [...sortedMesh.nodeModelMatrix];
    } else {
        lightingMatrix = mat4.multiply([], modelParameters.zScaleMatrix, sortedMesh.nodeModelMatrix);
    }
    mat4.multiply(lightingMatrix, modelParameters.negCameraPosMatrix, lightingMatrix);
    const normalMatrix = mat4.invert([], lightingMatrix);
    mat4.transpose(normalMatrix, normalMatrix);

    const uniformValues = modelUniformValues(
        new Float32Array(sortedMesh.worldViewProjection),
        new Float32Array(lightingMatrix),
        new Float32Array(normalMatrix),
        painter,
        opacity,
        pbr.baseColorFactor,
        material.emissiveFactor,
        pbr.metallicFactor,
        pbr.roughnessFactor,
        material,
        layer);

    const definesValues = [];
    // Extra buffers (colors, normals, texCoords)
    const dynamicBuffers = [];

    setupMeshDraw(definesValues, dynamicBuffers, mesh, painter);

    const program = painter.useProgram('model', null, ((definesValues: any): DynamicDefinesType[]));
    if (painter.style.fog) {
        const fogMatrix = fogMatrixForModel(sortedMesh.nodeModelMatrix, painter.transform);
        definesValues.push('FOG');
        painter.uploadCommonUniforms(context, program, null, new Float32Array(fogMatrix));
    }
    program.draw(context, context.gl.TRIANGLES, depthMode, stencilMode, colorMode, CullFaceMode.backCCW,
            uniformValues, layer.id, mesh.vertexBuffer, mesh.indexBuffer, mesh.segments, layer.paint, painter.transform.zoom,
            undefined, dynamicBuffers);
}

export function upload(painter: Painter, sourceCache: SourceCache) {
    const modelSource = sourceCache.getSource();
    if (!modelSource.loaded()) return;
    if (modelSource.type === 'vector' || modelSource.type === 'geojson') {
        if (painter.style.modelManager) {
            // Do it here, to prevent modelManager handling in Painter.
            painter.style.modelManager.upload(painter);
        }
        return;
    }
    const models = (modelSource: any).getModels();

    // Upload models
    for (const model of models) {
        model.upload(painter.context);
    }
}

function prepareMeshes(transform: Transform, node: Node, modelMatrix: Mat4, projectionMatrix: Mat4, modelIndex: number, transparentMeshes: Array<SortedMesh>,  opaqueMeshes: Array<SortedMesh>) {

    let nodeModelMatrix;
    if (transform.projection.name === 'globe') {
        nodeModelMatrix = convertModelMatrixForGlobe(modelMatrix, transform);
    } else {
        nodeModelMatrix = [...modelMatrix];
    }
    mat4.multiply(nodeModelMatrix, nodeModelMatrix, node.matrix);
    const worldViewProjection = mat4.multiply([], projectionMatrix, nodeModelMatrix);
    if (node.meshes) {
        for (const mesh of node.meshes) {
            if (mesh.material.alphaMode !== 'BLEND') {
                const opaqueMesh: SortedMesh = {mesh, depth: 0.0, modelIndex, worldViewProjection, nodeModelMatrix};
                opaqueMeshes.push(opaqueMesh);
                continue;
            }

            const centroidPos = vec3.transformMat4([], mesh.centroid, worldViewProjection);
            // Filter meshes behind the camera
            if (centroidPos[2] > 0.0) {
                const transparentMesh: SortedMesh = {mesh, depth: centroidPos[2], modelIndex, worldViewProjection, nodeModelMatrix};
                transparentMeshes.push(transparentMesh);
            }
        }
    }
    if (node.children) {
        for (const child of node.children) {
            prepareMeshes(transform, child, modelMatrix, projectionMatrix, modelIndex, transparentMeshes, opaqueMeshes);
        }
    }
}

function drawModels(painter: Painter, sourceCache: SourceCache, layer: ModelStyleLayer, coords: Array<OverscaledTileID>) {
    if (painter.renderPass !== 'translucent') return;
    // early return if totally transparent
    const opacity = layer.paint.get('model-opacity');
    if (opacity === 0) {
        return;
    }

    const modelSource = sourceCache.getSource();

    if (!modelSource.loaded()) return;
    if (modelSource.type === 'vector' || modelSource.type === 'geojson') {
        drawInstancedModels(painter, sourceCache, layer, coords);
        return;
    }
    const models = (modelSource: any).getModels();
    const modelParametersVector: ModelParameters[] = [];

    const mercCameraPos = (painter.transform.getFreeCameraOptions().position: any);
    const cameraPos = vec3.scale([], [mercCameraPos.x, mercCameraPos.y, mercCameraPos.z], painter.transform.worldSize);
    vec3.negate(cameraPos, cameraPos);
    const transparentMeshes: SortedMesh[] = [];
    const opaqueMeshes: SortedMesh[] = [];
    let modelIndex = 0;
    // Draw models
    for (const model of models) {
        const rotation = layer.paint.get('model-rotation').constantOr((null: any));
        const scale = layer.paint.get('model-scale').constantOr((null: any));
        const translation = layer.paint.get('model-translation').constantOr((null: any));
        // update model matrices
        model.computeModelMatrix(painter, rotation, scale, translation, true, true, false);

        // compute model parameters matrices
        const negCameraPosMatrix = mat4.identity([]);
        const modelMetersPerPixel = getMetersPerPixelAtLatitude(model.position.lat, painter.transform.zoom);
        const modelPixelsPerMeter = 1.0 / modelMetersPerPixel;
        const zScaleMatrix = mat4.fromScaling([], [1.0, 1.0, modelPixelsPerMeter]);
        mat4.translate(negCameraPosMatrix, negCameraPosMatrix, cameraPos);
        const modelParameters = {zScaleMatrix, negCameraPosMatrix};
        modelParametersVector.push(modelParameters);
        for (const node of model.nodes) {
            prepareMeshes(painter.transform, node, model.matrix, painter.transform.projMatrix, modelIndex, transparentMeshes, opaqueMeshes);
        }
        modelIndex++;
    }
    // Sort the transparent meshes by depth
    transparentMeshes.sort((a, b) => {
        return b.depth - a.depth;
    });

    // Draw opaque meshes
    if (opacity === 1) {
        for (const opaqueMesh of opaqueMeshes) {
            drawMesh(opaqueMesh, painter, layer, modelParametersVector[opaqueMesh.modelIndex], StencilMode.disabled, painter.colorModeForRenderPass());
        }
    } else {
        for (const opaqueMesh of opaqueMeshes) {
            // If we have layer opacity draw with two passes opaque meshes
            drawMesh(opaqueMesh, painter, layer, modelParametersVector[opaqueMesh.modelIndex], StencilMode.disabled, ColorMode.disabled);
        }
        for (const opaqueMesh of opaqueMeshes) {
            drawMesh(opaqueMesh, painter, layer, modelParametersVector[opaqueMesh.modelIndex], painter.stencilModeFor3D(), painter.colorModeForRenderPass());
        }
        painter.resetStencilClippingMasks();
    }

    // Draw transparent sorted meshes
    for (const transparentMesh of transparentMeshes) {
        drawMesh(transparentMesh, painter, layer, modelParametersVector[transparentMesh.modelIndex], StencilMode.disabled, painter.colorModeForRenderPass());
    }
}

// If terrain changes, update elevations (baked in translation).
function updateModelBucketsElevation(painter: Painter, bucket: ModelBucket, bucketTileID: OverscaledTileID) {
    let exaggeration = painter.terrain ? painter.terrain.exaggeration() : 0;
    let dem: ?DEMSampler;
    if (painter.terrain && exaggeration > 0) {
        const terrain = painter.terrain;
        const demTile = terrain.findDEMTileFor(bucketTileID);
        if (demTile && demTile.dem) {
            dem = DEMSampler.create(terrain, bucketTileID, demTile);
        } else {
            exaggeration = 0;
        }
    }
    if (exaggeration === bucket.validForExaggeration &&
        (exaggeration === 0 || (dem && dem._demTile && dem._demTile.tileID.canonical === bucket.validForDEMTile))) {
        return;
    }

    for (const modelId in bucket.instancesPerModel) {
        const instances = bucket.instancesPerModel[modelId];
        assert(instances.instancedDataArray.bytesPerElement === 64);
        for (let i = 0; i < instances.instancedDataArray.length; ++i) {
            const x = instances.instancedDataArray.float32[i * 16] | 0;
            const y = instances.instancedDataArray.float32[i * 16 + 1] | 0;
            const elevation = (dem ? exaggeration * dem.getElevationAt(x, y, true) : 0) + instances.instancesEvaluatedElevation[i];
            instances.instancedDataArray.float32[i * 16 + 6] = elevation;
        }
    }
    bucket.validForExaggeration = exaggeration;
    bucket.validForDEMTile = dem && dem._demTile ? dem._demTile.tileID.canonical : undefined;
    bucket.uploaded = false;
    bucket.upload(painter.context);
}

function drawInstancedModels(painter: Painter, source: SourceCache, layer: ModelStyleLayer, coords: Array<OverscaledTileID>) {
    const tr = painter.transform;
    if (tr.projection.name !== 'mercator') {
        warnOnce(`Drawing 3D models for ${tr.projection.name} projection is not yet implemented`);
        return;
    }

    const mercCameraPos = (painter.transform.getFreeCameraOptions().position: any);
    if (!painter.style.modelManager) return;
    const modelManager = painter.style.modelManager;

    for (const coord of coords) {
        const tile = source.getTile(coord);
        const bucket: ?ModelBucket = (tile.getBucket(layer): any);
        if (!bucket || bucket.projection.name !== tr.projection.name) continue;
        updateModelBucketsElevation(painter, bucket, coord);

        // camera position in the tile coordinates
        let cameraPos = vec3.scale([], [mercCameraPos.x, mercCameraPos.y, mercCameraPos.z], (1 << coord.canonical.z));
        cameraPos = [(cameraPos[0] - coord.canonical.x - coord.wrap * (1 << coord.canonical.z)) * EXTENT,
            (cameraPos[1] - coord.canonical.y) * EXTENT, cameraPos[2] * EXTENT];

        for (const modelId in bucket.instancesPerModel) {
            const model = modelManager.getModel(modelId);
            if (!model) continue;
            const modelInstances = bucket.instancesPerModel[modelId];
            for (const node of model.nodes) {
                drawInstancedNode(painter, layer, node, modelInstances, cameraPos, coord);
            }
        }
    }
}

function drawInstancedNode(painter, layer, node, modelInstances, cameraPos, coord) {
    const context = painter.context;
    if (node.meshes) {
        const depthMode = new DepthMode(context.gl.LEQUAL, DepthMode.ReadWrite, painter.depthRangeFor3D);
        for (const mesh of node.meshes) {
            const definesValues = [];
            const dynamicBuffers = [];
            setupMeshDraw(definesValues, dynamicBuffers, mesh, painter);
            definesValues.push('MODEL_POSITION_ON_GPU');
            const program = painter.useProgram('model', null, ((definesValues: any): DynamicDefinesType[]));

            const isShadowPass = painter.renderPass === 'shadow';
            const shadowRenderer = painter.shadowRenderer;
            if (!isShadowPass && shadowRenderer) {
                shadowRenderer.setupShadows(coord.toUnwrapped(), program);
            }

            painter.uploadCommonUniforms(context, program, coord.toUnwrapped());

            const material = mesh.material;
            const pbr = material.pbrMetallicRoughness;

            const uniformValues = modelUniformValues(
                coord.projMatrix,
                Float32Array.from(node.matrix),
                new Float32Array(16),
                painter,
                layer.paint.get('model-opacity'),
                pbr.baseColorFactor,
                material.emissiveFactor,
                pbr.metallicFactor,
                pbr.roughnessFactor,
                material,
                layer,
                cameraPos);

            assert(modelInstances.instancedDataArray.bytesPerElement === 64);

            for (let i = 0; i < modelInstances.instancedDataArray.length; ++i) {
                uniformValues["u_normal_matrix"] = new Float32Array(modelInstances.instancedDataArray.arrayBuffer, i * 64, 16);
                program.draw(context, context.gl.TRIANGLES, depthMode, StencilMode.disabled, painter.colorModeForRenderPass(), CullFaceMode.disabled,
                        uniformValues, layer.id, mesh.vertexBuffer, mesh.indexBuffer, mesh.segments, layer.paint, painter.transform.zoom,
                        undefined, dynamicBuffers);
            }
        }
    }
    if (node.children) {
        for (const child of node.children) {
            drawInstancedNode(painter, layer, child, modelInstances, cameraPos, coord);
        }
    }
}

