import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SourceProfile } from "../../src/app-types/WorkSource.types.ts";
import { mappingSchema } from "./mapping.ts";

export const profileSchema = z.object({ id: z.string().max(100), name: z.string().trim().min(1).max(100), revision: z.number().int().min(0), mapping: mappingSchema }).strict();

export function listProfiles(db: DatabaseSync): SourceProfile[] {
  return (db.prepare("SELECT id, name, revision, mapping FROM source_profiles ORDER BY name").all() as Array<Omit<SourceProfile, "mapping"> & { mapping: string }>).map((row) => ({ ...row, mapping: JSON.parse(row.mapping) }));
}

export function saveProfile(db: DatabaseSync, input: SourceProfile, fingerprint: string): SourceProfile {
  const profile = profileSchema.parse(input);
  const next = { ...profile, id: profile.id || randomUUID(), revision: profile.revision + 1 };
  if (!profile.id) {
    if (profile.revision !== 0) throw new Error("새 매핑의 버전이 올바르지 않습니다.");
    db.prepare("INSERT INTO source_profiles (id, name, revision, mapping, verified_fingerprint) VALUES (?, ?, ?, ?, ?)").run(next.id, next.name, next.revision, JSON.stringify(next.mapping), fingerprint);
  } else {
    const changed = db.prepare("UPDATE source_profiles SET name = ?, revision = ?, mapping = ?, verified_fingerprint = ? WHERE id = ? AND revision = ?")
      .run(next.name, next.revision, JSON.stringify(next.mapping), fingerprint, profile.id, profile.revision);
    if (changed.changes !== 1) throw new Error("매핑이 변경되었거나 삭제되었습니다. 저장된 매핑을 다시 불러와 주세요.");
  }
  return next;
}
