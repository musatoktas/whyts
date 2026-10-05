// A small, valid client assignment with 676 structurally compared properties.
// Timings and sampled trace events vary across machines and compiler versions.
type Letter = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j'
  | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u'
  | 'v' | 'w' | 'x' | 'y' | 'z';
type Route = `${Letter}${Letter}`;

type FullClient = {
  [K in Route]: { route: K; response: { id: K; metadata: K } };
};
type PublicClient = {
  [K in Route]: { route: K; response: { id: K } };
};

declare const fullClient: FullClient;
export const publicClient: PublicClient = fullClient;
