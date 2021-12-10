// @flow
import albers from './albers.js';
import equalEarth from './equal_earth.js';
import equirectangular from './equirectangular.js';
import lambertConformalConic from './lambert.js';
import mercator from './mercator.js';
import naturalEarth from './natural_earth.js';
import winkelTripel from './winkel_tripel.js';
import cylindricalEqualArea from './cylindrical_equal_area.js';
import {extend} from '../../util/util.js';
import type {ProjectionSpecification} from '../../style-spec/types.js';
import globe from './globe.js';
import {mat4, vec3} from 'gl-matrix';
import {CanonicalTileID, UnwrappedTileID} from '../../source/tile_id.js';
import Transform from '../transform.js';
import LngLat from '../lng_lat.js';
import Point from '@mapbox/point-geometry';
import MercatorCoordinate, {mercatorZfromAltitude} from '../mercator_coordinate.js';
import FlatTileTransform from './flat_tile_transform.js';
import {farthestPixelDistanceOnPlane} from './far_z.js';

export type Projection = {
    name: string,
    center: [number, number],
    parallels?: [number, number],
    range?: [number, number],
    conic?: boolean,
    wrap?: boolean,
    name: string,
    requiresDraping?: boolean,
    supportsTerrain?: boolean;
    supportsFog?: boolean;
    supportsCustomLayers?: boolean,
    supportsFreeCamera?: boolean,
    supportsWorldCopies?: boolean,
    // Whether the projection reprojects data in tile space
    isReprojectedInTileSpace?: boolean;
    zAxisUnit: "meters" | "pixels",
    project: (lng: number, lat: number) => {x: number, y: number, z: number},
    unproject: (x: number, y: number) => LngLat,
    locationPoint: (tr: Transform, lngLat: LngLat) => Point,
    projectTilePoint: (x: number, y: number, id: CanonicalTileID) => {x: number, y: number, z: number},
    pixelsPerMeter: (lat: number, worldSize: number) => number,
    farthestPixelDistance: (tr: Transform) => number,
    createTileTransform: (tr: Transform, worldSize: number) => TileTransform,
};

const projections = {
    globe,
    albers,
    equalEarth,
    equirectangular,
    lambertConformalConic,
    mercator,
    naturalEarth,
    winkelTripel
};

function projectTilePoint(x, y) {
    return {x, y, z: 0};
}

function locationPoint(tr, lngLat) {
    return tr._coordinatePoint(tr.locationCoordinate(lngLat), false);
}

function pixelsPerMeter(lat, worldSize) {
    return mercatorZfromAltitude(1, lat) * worldSize;
}

function farthestPixelDistance(tr) {
    return farthestPixelDistanceOnPlane(tr, pixelsPerMeter(tr.center.lat, tr.worldSize));
}

function createTileTransform(tr, worldSize) {
    return new FlatTileTransform(tr, worldSize);
}

const defaultFlatProjectionFunctions = {
    projectTilePoint,
    locationPoint,
    pixelsPerMeter,
    farthestPixelDistance,
    createTileTransform
};

function extendProjection(projection: Projection, config: ProjectionSpecification) {
    const defaultFunctions = projection.name === 'globe' ? {} : defaultFlatProjectionFunctions;
    if (projection.conic) {
        if (config.parallels) {
            // parallels that are equal but with opposite signs (e.g. [10, -10])
            // create a cylindrical projection so we replace the
            // project and unproject functions with equivalent cylindrical versions
            if (Math.abs(config.parallels[0] + config.parallels[1]) < 0.01) {
                let cylindricalFunctions = cylindricalEqualArea((config: any).parallels[0]);

                if (config.name === 'lambertConformalConic') {
                    const {project, unproject} = projections['mercator'];
                    cylindricalFunctions = {wrap: true, supportsWorldCopies: true, project, unproject};
                }

                return extend(projection, config, cylindricalFunctions, defaultFunctions);
            }
        }
    }
    return extend(projection, config, defaultFunctions);
}

export function getProjection(config: ProjectionSpecification) {
    let projection = projections[config.name];
    if (!projection) {
        throw new Error(`Invalid projection name: ${config.name}`);
    }
    return extendProjection(projection, config);
}

export type TileTransform = {
    createTileMatrix: (id: UnwrappedTileID) => mat4,
    createInversionMatrix: (id: UnwrappedTileID) => mat4,
    upVector: (id: CanonicalTileID, x: number, y: number) => vec3,
    upVectorScale: (id: CanonicalTileID) => number,
    pointCoordinate: (x: number, y: number, z?: number) => MercatorCoordinate
};
