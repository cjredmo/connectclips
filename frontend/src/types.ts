export type Sermon = {
  name: string
  size_bytes: number
  modified_at: string
  transcribed: boolean
  clips_selected: boolean
  n_clips: number
}

export type PreviousExport = {
  filename: string
  start: number
  end: number
  exported_at: string | null
  by_name: string | null
}

// Volunteer's per-clip edits saved to the backend so they survive
// page navigation. Each field maps 1:1 to the export-clip request body.
export type ClipUserEdits = {
  start?: number
  end?: number
  caption_style?: string
  // null means "no override" -- backend strips null fields before saving.
  caption_margin_v?: number | null
  include_hook_title?: boolean
  identity_id?: number | null
  // "tight" | "medium" | "wide". Unset = backend default ("medium").
  zoom_level?: ZoomLevel | null
  // true = static crop at median face position (no per-frame tracking).
  // unset / false = smoothed tracking with deadband.
  lock_camera?: boolean | null
}

export type ZoomLevel = 'tight' | 'medium' | 'wide' | 'stage'

// Version 1 is served by /api/caption-styles from the backend's built-ins.
// A chunk limit of one means one word at a time; larger limits use progressive
// reveal with an active word. No preset ID controls presentation behavior.
export type CaptionStyle = {
  schema_version: 1
  key: string
  label: string
  font_name: string
  font_size: number
  font_weight: number
  primary_color: string
  highlight_color: string
  outline_color: string
  outline_width: number
  shadow_depth: number
  highlight_scale: number
  vertical_anchor: 'bottom' | 'middle' | 'top'
  margin_v: number
  max_words_per_chunk: number
  max_chars_per_chunk: number
  background_box: boolean
  background_color: string
  background_opacity: number
  preview_highlight_color: string | null
  preview_background_opacity: number | null
}

export type Clip = {
  start: number          // effective: Claude's value, overridden by user_edits.start if set
  end: number            // effective
  title: string
  rationale: string
  hook_score?: number
  hook_rationale?: string
  exported: boolean
  output_filename: string | null
  stale_export?: boolean
  previous_export?: PreviousExport | null
  last_exported_by_login: string | null
  last_exported_by_name: string | null
  last_exported_at: string | null
  // Edits the volunteer has saved for this clip. Empty object if none.
  user_edits?: ClipUserEdits
  // Claude's untouched start/end -- for a future "Reset to suggestion" button.
  original?: { start: number; end: number }
}

export type Track = {
  n_frames: number
  src_w: number
  src_h: number
  fps: number
  out_w: number
  out_h: number
  track: [number, number, number][]  // [cx, cy, crop_h] per source frame
}

export type Identity = {
  id: number
  n_samples: number
  first_frame: number
  last_frame: number
  score_max: number
  thumb_frame_idx: number
  thumb_box: { cx: number; cy: number; w: number; h: number }
}

export type IdentitiesResponse = {
  scanned: boolean
  identities: Identity[]
}

export type TranscriptWord = {
  text: string
  start: number  // clip-relative seconds (offset from the requested range start)
  end: number
}

export type RawTranscriptWord = { word: string; start: number; end: number }
export type TranscriptSegment = {
  id: number | string
  start: number
  end: number
  text: string
  words: RawTranscriptWord[]
  raw_words: RawTranscriptWord[]
  reference_words?: RawTranscriptWord[]
}
export type TranscriptEdit = {
  id: string
  segment_id: number | string
  word_index: number
  original_words: RawTranscriptWord[]
  original_text: string
  corrected_text: string
  edited_at: string
  affected_start: number
  affected_end: number
  timing_needs_alignment: boolean
}
export type TranscriptQuality = { status: string; findings: unknown[] }

export type TranscriptRepairStatus = {
  repair_exists: boolean
  repair_status: string
  repair_failure_reason: string | null
  recent_repair_attempts: { status: string; backend?: string; failure_reason?: string }[]
  repaired_ranges: { start: number; end: number; backend: string; model: string }[]
  human_review_required: boolean
  warnings: string[]
}

export type AlignmentStatus = {
  status: 'not_aligned' | 'aligning' | 'aligned' | 'partially_aligned' | 'stale' | 'failed'
  acceptable: boolean
  aligned_words: number
  total_words: number
  fallback_words: number
  stale_ranges: [number, number][]
  diagnostics: string[]
}

export type TranscriptResponse = {
  source: string
  segments: TranscriptSegment[]
  edits: TranscriptEdit[]
  warnings: string[]
  quality: TranscriptQuality
  raw_quality: TranscriptQuality
  effective_quality: TranscriptQuality
  repair: TranscriptRepairStatus
  // False for an older running backend that serves raw words without the
  // effective-transcript fields needed to save corrections safely.
  supports_effective_transcript: boolean
}

export type TranscriptStatus = TranscriptRepairStatus & {
  raw_quality: TranscriptQuality
  effective_quality: TranscriptQuality
  alignment: AlignmentStatus
}

export type Me = {
  login: string | null
  name: string | null
  profile_pic: string | null
  admin: boolean
  anonymous: boolean
}

export type ClipsFile = {
  source: string
  model: string
  created_at: string
  usage: Record<string, number>
  clips: Clip[]
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export type UsageRow = {
  source: string
  model: string | null
  created_at: string | null
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  estimated_cost_usd: number
}

export type UsageSummary = {
  n_clip_selections: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_creation_input_tokens: number
  total_cache_read_input_tokens: number
  total_estimated_cost_usd: number
}

export type Topup = {
  id: number
  amount_usd: number
  note: string | null
  created_at: string
}

export type Balance = {
  total_topups_usd: number
  total_spent_since_first_topup_usd: number
  estimated_balance_usd: number
  low_threshold_usd: number
  is_low: boolean
  first_topup_at: string
  topups: Topup[]
}

export type UsageResponse = {
  rows: UsageRow[]
  summary: UsageSummary
  // null until the admin records their first top-up — the UI shows a
  // CTA to log a top-up instead of a meaningless balance number.
  balance: Balance | null
}

export type Job = {
  id: string
  kind: 'transcribe' | 'repair_transcript' | 'align_transcript' | 'youtube_download' | 'select_clips' | 'export_clip' | 'upload' | 'prescan_faces'
  status: JobStatus
  source: string | null
  transcript_path: string | null
  url: string | null
  ingested_filename: string | null
  clips_path: string | null
  clip_index: number | null
  start: number | null
  end: number | null
  output_clip_path: string | null
  identity_id: number | null
  user_login: string | null
  user_name: string | null
  progress_percent: number | null
  progress_message: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
}
