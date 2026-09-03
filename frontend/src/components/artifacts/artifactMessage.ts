export interface UploadedArtifactChip {
  id: string;
  name: string;
}

export function uploadedArtifactChips(text: string): UploadedArtifactChip[] {
  const chips: UploadedArtifactChip[] = [];
  const pattern = /<file\b[^>]*\bartifact_id="([^"]+)"[^>]*>([\s\S]*?)<\/file>/gu;
  for (const match of text.matchAll(pattern)) {
    const label = /\[Uploaded (?:image|file) ([^;\]]+)/u.exec(match[2])?.[1]?.trim() || "Uploaded artifact";
    chips.push({ id: match[1], name: label });
  }
  return chips;
}

export function userVisibleMessageText(text: string): string {
  return text.replace(/<file\b[^>]*\bartifact_id="[^"]+"[^>]*>[\s\S]*?<\/file>/gu, "").trim();
}
