# Clip JSON import, schema version 1

Save a UTF-8 `.json` file containing a JSON object in this format, then choose **Import JSON** on a sermon's Pick clips step:

```json
{
  "schema_version": 1,
  "clips": [
    {
      "title": "Example clip title",
      "start": "10:00.000",
      "end": "10:35.000",
      "description": "A concise summary of the passage.",
      "why_selected": "Why this passage works as a standalone clip.",
      "hook": "A concise description of its opening.",
      "score": 82
    }
  ]
}
```

`title`, `start`, and `end` are required. The other fields are optional. `score`, when present, must be a finite number from 0 to 100. Times may be finite numeric seconds, a seconds string, `MM:SS[.mmm]`, or `HH:MM:SS[.mmm]`. The end must follow the start and stay within the known sermon duration.

The import rejects unknown fields and validates every clip before adding any of them. Existing clips remain in place. A repeated import skips clips with the same normalized title and start/end times. ConnectClips assigns each imported clip its internal ID and `json_import` origin; leave those fields out of the file.

The clip list also supports existing AI suggestions and manually created clips. For display, older AI fields map to the same editorial model: `rationale` → `why_selected`, `hook_rationale` → `hook`, and `hook_score` → `score`. Legacy files are read without rewriting their stored wording.
