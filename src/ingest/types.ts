/**
 * A posting as published by a board, before anything has been normalised or stored.
 * This is the only shape the ingest layer hands to the rest of the system.
 */
export interface RawPosting {
  readonly source: string;
  readonly externalId: string;
  readonly companySlug: string;
  readonly companyName: string;
  readonly title: string;
  readonly department: string | null;
  readonly url: string;
  /** The board's location eligibility text, verbatim. Never cleaned up here. */
  readonly rawLocationText: string;
}
