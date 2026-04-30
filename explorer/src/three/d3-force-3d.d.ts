/**
 * Minimal ambient typings for `d3-force-3d`.
 *
 * Upstream ships JS without TypeScript declarations. We only consume the
 * subset listed here; expand as more forces are wired in.
 *
 * Refs:
 *   - https://github.com/vasturiano/d3-force-3d
 *   - explorer/src/three/layoutEngine.ts
 */
declare module "d3-force-3d" {
  // Loose Node shape — we mutate x/y/z/vx/vy/vz on these in place.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export interface ForceNode {
    [k: string]: any;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export interface ForceLink {
    source: string | ForceNode;
    target: string | ForceNode;
    [k: string]: any;
  }

  export interface Simulation<N extends ForceNode = ForceNode> {
    nodes(): N[];
    nodes(nodes: N[]): this;
    force(name: string): unknown;
    force(name: string, force: unknown | null): this;
    tick(iterations?: number): this;
    alpha(): number;
    alpha(value: number): this;
    alphaMin(value: number): this;
    alphaDecay(value: number): this;
    velocityDecay(value: number): this;
    randomSource(source: () => number): this;
    stop(): this;
    on(event: "tick" | "end", listener: ((this: this) => void) | null): this;
  }

  export function forceSimulation<N extends ForceNode = ForceNode>(
    nodes?: N[],
    numDimensions?: number,
  ): Simulation<N>;

  export interface ManyBodyForce {
    strength(value: number | ((d: ForceNode) => number)): this;
    distanceMin(value: number): this;
    distanceMax(value: number): this;
    theta(value: number): this;
  }
  export function forceManyBody(): ManyBodyForce;

  export interface LinkForce<L extends ForceLink = ForceLink> {
    links(links: L[]): this;
    id(accessor: (n: ForceNode) => string): this;
    distance(value: number | ((l: L) => number)): this;
    strength(value: number | ((l: L) => number)): this;
    iterations(value: number): this;
  }
  export function forceLink<L extends ForceLink = ForceLink>(
    links?: L[],
  ): LinkForce<L>;

  export interface CenterForce {
    strength(value: number): this;
    x(value: number): this;
    y(value: number): this;
    z(value: number): this;
  }
  export function forceCenter(x?: number, y?: number, z?: number): CenterForce;

  export interface CollideForce {
    radius(value: number | ((d: ForceNode) => number)): this;
    strength(value: number): this;
    iterations(value: number): this;
  }
  export function forceCollide(radius?: number | ((d: ForceNode) => number)): CollideForce;
}
