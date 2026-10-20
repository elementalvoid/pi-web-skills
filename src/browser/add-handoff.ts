/**
 * One Add handoff requested by Search: the source to resolve and the skill to
 * preselect once the source has resolved. The Add panel consumes it on render.
 */
export type AddHandoff = {
  readonly source: string;
  readonly skillName: string;
};

/** The identity of one hosted panel: a handoff is never shared across them. */
export function addHandoffKey(context: {
  readonly machine: { readonly id: string };
  readonly workspace: { readonly id: string };
}): string {
  return `${context.machine.id}\u0000${context.workspace.id}`;
}

/** Shared by the Search and Add panels of one activation. */
export type AddHandoffBox = {
  set(key: string, handoff: AddHandoff): void;
  /** Read and clear; the consumed handoff cannot start a second resolve. */
  take(key: string): AddHandoff | null;
};

export function createAddHandoff(): AddHandoffBox {
  const pending = new Map<string, AddHandoff>();
  return {
    set: (key, handoff) => {
      pending.set(key, handoff);
    },
    take: (key) => {
      const handoff = pending.get(key) ?? null;
      pending.delete(key);
      return handoff;
    },
  };
}
