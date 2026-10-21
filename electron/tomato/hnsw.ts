/**
 * Dependency-free HNSW (Malkov & Yashunin, 2018) for cosine similarity over unit vectors.
 *
 * Why in-process TypeScript rather than sqlite-vec or a native library: Tomato runs inside an Electron
 * utility process on end-user PCs, where native modules must be rebuilt per Electron ABI and platform.
 * A pure-TS graph keeps the install footprint unchanged and is ample for local corpora (10^4–10^6 chunks).
 *
 * Small indexes answer exactly (flat scan) because brute force is both faster and perfectly recalled there;
 * the graph is still maintained so the switch to approximate search at `exactBelow` is seamless.
 */

/** Neighbour lists may overflow by this much before the diversity heuristic prunes them (see `add`). */
const SHRINK_SLACK = 8;

export interface HnswOptions {
  dimensions: number;
  /** Max neighbours per node above layer 0 (layer 0 keeps 2×M). */
  m?: number;
  /** Candidate list size during insertion. */
  efConstruction?: number;
  /** Default candidate list size during search; raised to `k` when smaller. */
  efSearch?: number;
  /** Below this many live vectors, `search` is an exact flat scan. */
  exactBelow?: number;
  /** Seed for level assignment, so builds are reproducible in tests and across restarts. */
  seed?: number;
}

/** Serializable graph structure; vectors travel separately as a packed Float32Array (see `vectorData`). */
export interface HnswGraph {
  version: 1;
  dimensions: number;
  m: number;
  efConstruction: number;
  seed: number;
  ids: string[];
  levels: number[];
  neighbours: number[][][];
  /** node indexes that are tombstoned */
  deleted: number[];
  entryPoint: number;
  maxLevel: number;
}

export interface HnswHit {
  id: string;
  /** Cosine similarity in [-1, 1]. */
  score: number;
}

interface Candidate {
  node: number;
  score: number;
}

export class HnswIndex {
  readonly dimensions: number;
  private readonly m: number;
  private readonly m0: number;
  private readonly efConstruction: number;
  private readonly efSearch: number;
  private readonly exactBelow: number;
  private readonly levelMultiplier: number;
  private random: () => number;
  private readonly seed: number;

  private ids: string[] = [];
  /** Vectors packed end to end (`node * dimensions`) for cache locality. */
  private data = new Float32Array(0);
  private levels: number[] = [];
  private visitStamp = new Uint32Array(0);
  private stamp = 0;
  /** neighbours[node][layer] = node indexes */
  private neighbours: number[][][] = [];
  private deleted: boolean[] = [];
  private byId = new Map<string, number>();
  private entryPoint = -1;
  private maxLevel = -1;
  private liveCount = 0;

  constructor(options: HnswOptions) {
    this.dimensions = options.dimensions;
    this.m = Math.max(2, options.m ?? 16);
    this.m0 = this.m * 2;
    this.efConstruction = Math.max(this.m, options.efConstruction ?? 80);
    this.efSearch = Math.max(this.m, options.efSearch ?? 64);
    this.exactBelow = Math.max(0, options.exactBelow ?? 2000);
    this.levelMultiplier = 1 / Math.log(this.m);
    this.seed = options.seed ?? 0x9e3779b9;
    this.random = mulberry32(this.seed);
  }

  /** Live (non-deleted) vectors. */
  get size(): number {
    return this.liveCount;
  }

  /** Stored slots including tombstones; `compact()` reclaims the difference. */
  get capacity(): number {
    return this.ids.length;
  }

  has(id: string): boolean {
    const node = this.byId.get(id);
    return node !== undefined && !this.deleted[node];
  }

  /** Inserts or replaces a vector. Vectors are copied and L2-normalized. */
  add(id: string, vector: Float32Array): void {
    if (vector.length !== this.dimensions) {
      throw new Error(`vector 차원이 다릅니다: ${vector.length} != ${this.dimensions}`);
    }
    if (this.byId.has(id)) this.remove(id);
    const normalized = normalize(vector);
    const level = this.randomLevel();
    const node = this.ids.length;
    this.ids.push(id);
    this.store(node, normalized);
    this.levels.push(level);
    this.deleted.push(false);
    this.neighbours.push(Array.from({ length: level + 1 }, () => []));
    this.byId.set(id, node);
    this.liveCount += 1;

    if (this.entryPoint < 0) {
      this.entryPoint = node;
      this.maxLevel = level;
      return;
    }

    let entry = this.entryPoint;
    for (let layer = this.maxLevel; layer > level; layer -= 1) {
      entry = this.greedyClosest(normalized, entry, layer);
    }
    for (let layer = Math.min(level, this.maxLevel); layer >= 0; layer -= 1) {
      const candidates = this.searchLayer(normalized, [entry], this.efConstruction, layer, true);
      const limit = layer === 0 ? this.m0 : this.m;
      const selected = this.selectNeighbours(candidates, limit);
      this.neighbours[node][layer] = selected;
      for (const neighbour of selected) {
        const list = this.neighbours[neighbour][layer];
        list.push(node);
        // Let lists overflow by a small slack and prune in one pass: the heuristic costs O(limit²) dots,
        // so pruning on every single overflow dominated build time (~70% in profiling).
        if (list.length > limit + SHRINK_SLACK) this.shrink(neighbour, layer, limit);
      }
      if (candidates.length) entry = candidates[0].node;
    }
    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPoint = node;
    }
  }

  /** Tombstones a vector; it keeps routing searches until `compact()` rebuilds the graph. */
  remove(id: string): boolean {
    const node = this.byId.get(id);
    if (node === undefined) return false;
    this.byId.delete(id);
    if (this.deleted[node]) return false;
    this.deleted[node] = true;
    this.liveCount -= 1;
    if (this.liveCount === 0) this.reset();
    return true;
  }

  /** Top-k by cosine similarity. Exact below `exactBelow`, HNSW otherwise. */
  search(query: Float32Array, k: number, ef?: number): HnswHit[] {
    if (query.length !== this.dimensions) {
      throw new Error(`vector 차원이 다릅니다: ${query.length} != ${this.dimensions}`);
    }
    if (k <= 0 || this.liveCount === 0) return [];
    const normalized = normalize(query);
    if (this.liveCount <= this.exactBelow) return this.exactSearch(normalized, k);

    let entry = this.entryPoint;
    for (let layer = this.maxLevel; layer > 0; layer -= 1) {
      entry = this.greedyClosest(normalized, entry, layer);
    }
    const width = Math.max(ef ?? this.efSearch, k);
    const hits = this.searchLayer(normalized, [entry], width, 0, false);
    return hits.slice(0, k).map((candidate) => ({ id: this.ids[candidate.node], score: candidate.score }));
  }

  /** Graph structure for persistence. Pair it with `vectorData()`; both describe the same node order. */
  toGraph(): HnswGraph {
    const deleted: number[] = [];
    this.deleted.forEach((flag, node) => {
      if (flag) deleted.push(node);
    });
    return {
      version: 1,
      dimensions: this.dimensions,
      m: this.m,
      efConstruction: this.efConstruction,
      seed: this.seed,
      ids: [...this.ids],
      levels: [...this.levels],
      neighbours: this.neighbours.map((layers) => layers.map((links) => [...links])),
      deleted,
      entryPoint: this.entryPoint,
      maxLevel: this.maxLevel,
    };
  }

  /** Packed vectors of every stored node (tombstones included), `ids.length × dimensions` floats. */
  vectorData(): Float32Array {
    return this.data.slice(0, this.ids.length * this.dimensions);
  }

  /** Rebuilds an index from `toGraph()` + `vectorData()` without re-running insertion. */
  static restore(graph: HnswGraph, data: Float32Array, options: Omit<HnswOptions, "dimensions" | "m" | "efConstruction" | "seed"> = {}): HnswIndex {
    if (graph.version !== 1) throw new Error(`지원하지 않는 HNSW graph version: ${graph.version}`);
    if (graph.ids.length !== graph.levels.length || graph.ids.length !== graph.neighbours.length) {
      throw new Error("HNSW graph 길이가 일치하지 않습니다.");
    }
    if (data.length !== graph.ids.length * graph.dimensions) {
      throw new Error(`HNSW vector data 크기가 다릅니다: ${data.length} != ${graph.ids.length * graph.dimensions}`);
    }
    const index = new HnswIndex({
      ...options, dimensions: graph.dimensions, m: graph.m, efConstruction: graph.efConstruction, seed: graph.seed,
    });
    index.ids = [...graph.ids];
    index.levels = [...graph.levels];
    index.neighbours = graph.neighbours.map((layers) => layers.map((links) => [...links]));
    index.deleted = graph.ids.map(() => false);
    for (const node of graph.deleted) index.deleted[node] = true;
    index.data = Float32Array.from(data);
    index.visitStamp = new Uint32Array(graph.ids.length);
    index.byId = new Map();
    graph.ids.forEach((id, node) => {
      if (!index.deleted[node]) index.byId.set(id, node);
    });
    index.liveCount = index.byId.size;
    index.entryPoint = graph.entryPoint;
    index.maxLevel = graph.maxLevel;
    // Advance the level RNG so restored indexes do not replay the first levels verbatim.
    for (let step = 0; step < graph.ids.length % 1024; step += 1) index.random();
    return index;
  }

  /** Rebuilds the graph from live vectors, dropping tombstones. Returns the number of live vectors. */
  compact(): number {
    const live = this.ids
      .map((id, node) => ({ id, node }))
      .filter(({ node }) => !this.deleted[node])
      .map(({ id, node }) => ({ id, vector: Float32Array.from(this.vector(node)) }));
    this.reset();
    for (const { id, vector } of live) this.add(id, vector);
    return this.liveCount;
  }

  /** True when tombstones have grown enough that a `compact()` is worthwhile. */
  needsCompaction(): boolean {
    const tombstones = this.ids.length - this.liveCount;
    return tombstones >= 256 && tombstones > this.liveCount * 0.3;
  }

  private store(node: number, vector: Float32Array): void {
    const needed = (node + 1) * this.dimensions;
    if (needed > this.data.length) {
      const grown = new Float32Array(Math.max(needed, this.data.length * 2, this.dimensions * 256));
      grown.set(this.data);
      this.data = grown;
      const stamps = new Uint32Array(grown.length / this.dimensions);
      stamps.set(this.visitStamp);
      this.visitStamp = stamps;
    }
    this.data.set(vector, node * this.dimensions);
  }

  private vector(node: number): Float32Array {
    return this.data.subarray(node * this.dimensions, (node + 1) * this.dimensions);
  }

  /** Dot product of `query` with the stored vector of `node`, without allocating a view. */
  private score(query: Float32Array, node: number): number {
    const data = this.data;
    const length = query.length;
    let offset = node * this.dimensions;
    let sum0 = 0;
    let sum1 = 0;
    let sum2 = 0;
    let sum3 = 0;
    let index = 0;
    for (; index + 3 < length; index += 4, offset += 4) {
      sum0 += query[index] * data[offset];
      sum1 += query[index + 1] * data[offset + 1];
      sum2 += query[index + 2] * data[offset + 2];
      sum3 += query[index + 3] * data[offset + 3];
    }
    for (; index < length; index += 1, offset += 1) sum0 += query[index] * data[offset];
    return sum0 + sum1 + sum2 + sum3;
  }

  private reset(): void {
    this.ids = [];
    this.data = new Float32Array(0);
    this.visitStamp = new Uint32Array(0);
    this.stamp = 0;
    this.levels = [];
    this.neighbours = [];
    this.deleted = [];
    this.byId = new Map();
    this.entryPoint = -1;
    this.maxLevel = -1;
    this.liveCount = 0;
    this.random = mulberry32(this.seed);
  }

  private exactSearch(query: Float32Array, k: number): HnswHit[] {
    const hits: HnswHit[] = [];
    for (let node = 0; node < this.ids.length; node += 1) {
      if (this.deleted[node]) continue;
      hits.push({ id: this.ids[node], score: this.score(query, node) });
    }
    hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    return hits.slice(0, k);
  }

  private randomLevel(): number {
    const uniform = Math.max(this.random(), Number.EPSILON);
    return Math.floor(-Math.log(uniform) * this.levelMultiplier);
  }

  private greedyClosest(query: Float32Array, start: number, layer: number): number {
    let current = start;
    let best = this.score(query, current);
    let improved = true;
    while (improved) {
      improved = false;
      for (const next of this.neighbours[current][layer]) {
        const score = this.score(query, next);
        if (score > best) {
          best = score;
          current = next;
          improved = true;
        }
      }
    }
    return current;
  }

  /**
   * Beam search on one layer. Returns up to `ef` results sorted by descending similarity.
   * Tombstoned nodes are traversed (they keep the graph connected) but excluded from results
   * unless `includeDeleted` is set, which insertion uses so new nodes still link through them.
   */
  private searchLayer(query: Float32Array, entries: number[], ef: number, layer: number, includeDeleted: boolean): Candidate[] {
    this.stamp += 1;
    if (this.stamp === 0xffffffff) {
      this.visitStamp.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const visited = this.visitStamp;
    const candidates = new MaxHeap(); // best first
    const results = new MinHeap(); // worst first, bounded to ef
    for (const node of entries) {
      visited[node] = stamp;
      const score = this.score(query, node);
      candidates.push(node, score);
      if (includeDeleted || !this.deleted[node]) results.push(node, score);
    }
    while (candidates.size) {
      const currentScore = candidates.topScore();
      const current = candidates.pop();
      if (results.size >= ef && currentScore < results.topScore()) break;
      const links = this.neighbours[current][layer];
      for (let index = 0; index < links.length; index += 1) {
        const next = links[index];
        if (visited[next] === stamp) continue;
        visited[next] = stamp;
        const score = this.score(query, next);
        if (results.size < ef || score > results.topScore()) {
          candidates.push(next, score);
          if (includeDeleted || !this.deleted[next]) {
            results.push(next, score);
            if (results.size > ef) results.pop();
          }
        }
      }
    }
    return results.drain().sort((left, right) => right.score - left.score || left.node - right.node);
  }

  /**
   * Heuristic neighbour selection (Algorithm 4 of the paper): walking candidates best-first, keep one only
   * if it is closer to the query than to every neighbour already kept. This favours diverse directions,
   * which is what keeps the graph navigable on clustered data (real embeddings are heavily clustered).
   * `candidates` must be sorted by descending score. Returns node indexes.
   */
  private selectNeighbours(candidates: Candidate[], limit: number): number[] {
    if (candidates.length <= limit) return candidates.map((candidate) => candidate.node);
    const selected: number[] = [];
    const discarded: number[] = [];
    for (const candidate of candidates) {
      if (selected.length >= limit) break;
      const vector = this.vector(candidate.node);
      let diverse = true;
      for (let index = 0; index < selected.length; index += 1) {
        if (this.score(vector, selected[index]) > candidate.score) {
          diverse = false;
          break;
        }
      }
      if (diverse) selected.push(candidate.node);
      else discarded.push(candidate.node);
    }
    for (let index = 0; selected.length < limit && index < discarded.length; index += 1) selected.push(discarded[index]);
    return selected;
  }

  /** Re-selects an overfull neighbour list with the same diversity heuristic, seen from that node. */
  private shrink(node: number, layer: number, limit: number): void {
    const vector = this.vector(node);
    const candidates = this.neighbours[node][layer]
      .map((next) => ({ node: next, score: this.score(vector, next) }))
      .sort((left, right) => right.score - left.score || left.node - right.node);
    this.neighbours[node][layer] = this.selectNeighbours(candidates, limit);
  }
}

export function dot(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) norm += vector[index] ** 2;
  norm = Math.sqrt(norm);
  const copy = new Float32Array(vector.length);
  if (norm === 0) return copy;
  for (let index = 0; index < vector.length; index += 1) copy[index] = vector[index] / norm;
  return copy;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Binary heap over (node, score) pairs in parallel arrays; `sign` picks max-heap (+1) or min-heap (-1). */
class ScoreHeap {
  private nodes: number[] = [];
  private scores: number[] = [];
  private readonly sign: 1 | -1;

  constructor(sign: 1 | -1) {
    this.sign = sign;
  }

  get size(): number {
    return this.nodes.length;
  }

  topScore(): number {
    return this.scores[0];
  }

  push(node: number, score: number): void {
    const nodes = this.nodes;
    const scores = this.scores;
    const key = score * this.sign;
    let index = nodes.length;
    nodes.push(node);
    scores.push(score);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (scores[parent] * this.sign >= key) break;
      nodes[index] = nodes[parent];
      scores[index] = scores[parent];
      index = parent;
    }
    nodes[index] = node;
    scores[index] = score;
  }

  pop(): number {
    const nodes = this.nodes;
    const scores = this.scores;
    const top = nodes[0];
    const lastNode = nodes.pop()!;
    const lastScore = scores.pop()!;
    const length = nodes.length;
    if (length) {
      const key = lastScore * this.sign;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        if (left >= length) break;
        const right = left + 1;
        const child = right < length && scores[right] * this.sign > scores[left] * this.sign ? right : left;
        if (scores[child] * this.sign <= key) break;
        nodes[index] = nodes[child];
        scores[index] = scores[child];
        index = child;
      }
      nodes[index] = lastNode;
      scores[index] = lastScore;
    }
    return top;
  }

  drain(): Candidate[] {
    const items = this.nodes.map((node, index) => ({ node, score: this.scores[index] }));
    this.nodes = [];
    this.scores = [];
    return items;
  }
}

class MaxHeap extends ScoreHeap {
  constructor() {
    super(1);
  }
}

class MinHeap extends ScoreHeap {
  constructor() {
    super(-1);
  }
}
