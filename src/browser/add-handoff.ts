/**
 * One Add handoff requested by Search: the source to resolve and the skill to
 * preselect once the source has resolved. The Add panel consumes it on render.
 */
export type AddHandoff = {
  readonly source: string;
  readonly skillName: string;
};

/** Shared by the Search and Add panels of one activation. */
export type AddHandoffBox = { pending: AddHandoff | null };

export function createAddHandoff(): AddHandoffBox {
  return { pending: null };
}
