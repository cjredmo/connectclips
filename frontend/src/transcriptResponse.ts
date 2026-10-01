import type {
  AlignmentStatus, TranscriptQuality, TranscriptRepairStatus,
  TranscriptResponse, TranscriptStatus,
} from './types'

type TranscriptWire = Partial<TranscriptResponse> & { quality?: TranscriptQuality }
type StatusWire = Partial<TranscriptStatus> & { quality?: TranscriptQuality }

const uncheckedQuality = (): TranscriptQuality => ({ status: 'unchecked', findings: [] })

const defaultRepair = (): TranscriptRepairStatus => ({
  repair_exists: false,
  repair_status: 'none',
  repair_failure_reason: null,
  recent_repair_attempts: [],
  repaired_ranges: [],
  human_review_required: false,
  warnings: [],
})

const defaultAlignment = (): AlignmentStatus => ({
  status: 'not_aligned',
  acceptable: false,
  aligned_words: 0,
  total_words: 0,
  fallback_words: 0,
  stale_ranges: [],
  diagnostics: [],
})

// The editor requires the effective-transcript response introduced with
// repairs. An older running backend may still return only `quality`.
export function normalizeTranscriptResponse(wire: TranscriptWire): TranscriptResponse {
  const supportsEffective = Boolean(wire.raw_quality && wire.effective_quality && wire.repair)
  return {
    source: wire.source ?? '',
    segments: wire.segments ?? [],
    edits: wire.edits ?? [],
    warnings: wire.warnings ?? [],
    quality: wire.quality ?? wire.raw_quality ?? uncheckedQuality(),
    raw_quality: wire.raw_quality ?? wire.quality ?? uncheckedQuality(),
    effective_quality: wire.effective_quality ?? uncheckedQuality(),
    repair: { ...defaultRepair(), ...wire.repair },
    supports_effective_transcript: supportsEffective,
  }
}

export function normalizeTranscriptStatus(wire: StatusWire): TranscriptStatus {
  return {
    ...defaultRepair(),
    ...wire,
    raw_quality: wire.raw_quality ?? wire.quality ?? uncheckedQuality(),
    effective_quality: wire.effective_quality ?? uncheckedQuality(),
    alignment: { ...defaultAlignment(), ...wire.alignment,
      stale_ranges: wire.alignment?.stale_ranges ?? [],
      diagnostics: wire.alignment?.diagnostics ?? [] },
  }
}
