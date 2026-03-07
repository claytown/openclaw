/**
 * Active persona tracking (in-memory). Maps session keys to persona names.
 * Uses globalThis singleton to survive module re-evaluation.
 */

const PERSONA_REGISTRY = Symbol.for("openclaw.ecsPersonaRegistry");
type PersonaMap = Map<string, string>;
type RegistryHolder = { map: PersonaMap };

function getRegistry(): PersonaMap {
  const g = globalThis as typeof globalThis & { [PERSONA_REGISTRY]?: RegistryHolder };
  if (!g[PERSONA_REGISTRY]) {
    g[PERSONA_REGISTRY] = { map: new Map() };
  }
  return g[PERSONA_REGISTRY].map;
}

export function setActivePersona(sessionKey: string, personaName: string): void {
  getRegistry().set(sessionKey, personaName);
}

export function getActivePersona(sessionKey: string): string | undefined {
  return getRegistry().get(sessionKey);
}

export function clearActivePersona(sessionKey: string): void {
  getRegistry().delete(sessionKey);
}

/** Test-only: reset all tracked personas. */
export const __testing = {
  clear: () => getRegistry().clear(),
};
