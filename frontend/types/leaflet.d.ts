declare module 'leaflet' {
  export type LatLngExpression = [number, number] | { lat: number; lng: number } | any;
  export type LatLngBounds = any;

  export interface IconOptions {
    className?: string;
    html?: string;
    iconSize?: [number, number];
    iconAnchor?: [number, number];
    popupAnchor?: [number, number];
  }

  export interface Icon {}

  export function divIcon(options?: IconOptions): Icon;

  export const Marker: {
    prototype: {
      options: {
        icon: any;
      };
    };
  };

  export function latLngBounds(coords: any): LatLngBounds;

  const L: {
    divIcon: typeof divIcon;
    Marker: typeof Marker;
    latLngBounds: typeof latLngBounds;
  };

  export default L;
}

declare module 'react-leaflet' {
  import * as React from 'react';

  export interface MapContainerProps {
    center?: any;
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
    scrollWheelZoom?: boolean;
    zoomControl?: boolean;
    className?: string;
    maxBounds?: any;
    maxBoundsViscosity?: number;
    'aria-label'?: string;
    children?: React.ReactNode;
  }

  export const MapContainer: React.ComponentType<MapContainerProps>;

  export interface TileLayerProps {
    url: string;
    attribution: string;
    maxZoom?: number;
  }

  export const TileLayer: React.ComponentType<TileLayerProps>;

  export interface ZoomControlProps {
    position: string;
  }

  export const ZoomControl: React.ComponentType<ZoomControlProps>;

  export interface MarkerProps {
    position: any;
    icon?: any;
    eventHandlers?: any;
    children?: React.ReactNode;
  }

  export const Marker: React.ComponentType<MarkerProps>;

  export interface PopupProps {
    closeButton?: boolean;
    autoPan?: boolean;
    className?: string;
    minWidth?: number;
    maxWidth?: number;
    children?: React.ReactNode;
  }

  export const Popup: React.ComponentType<PopupProps>;

  export function useMap(): any;
  export function useMapEvents(events: any): any;
}
