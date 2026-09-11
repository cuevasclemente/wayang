import type { SessionSearchResponse } from "../api/client";

export function searchStatusMessage(response: SessionSearchResponse): string | null {
  switch (response.degraded) {
    case "indexing_paused": return "Automatic indexing is paused. Results may be incomplete or out of date.";
    case "indexing_in_progress": return "Indexing is in progress. Results are incomplete; new content may take several minutes.";
    case "index_incomplete": return "The search index is incomplete. Some sessions or messages are not searchable yet.";
    case "index_unavailable": return "Search indexing is unavailable. Results may be incomplete.";
    default: return null;
  }
}
