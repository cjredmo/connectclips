"""Synthetic correction and quality checks; no runtime transcript is used."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services import captions, transcript_edits, transcript_quality


def sample_transcript():
    words = [
        {"word": "The", "start": 1.0, "end": 1.2},
        {"word": "prophet", "start": 1.2, "end": 1.6},
        {"word": "Ezekiel", "start": 1.6, "end": 2.1},
        {"word": "said.", "start": 2.1, "end": 2.5},
    ]
    return {"source": "sample.mp4", "duration": 5.0, "segments": [
        {"id": 0, "start": 1.0, "end": 2.5, "text": "The prophet Ezekiel said.", "words": words},
    ]}


class TranscriptEditsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "transcript.json"
        self.path.write_text(json.dumps(sample_transcript()), encoding="utf-8")
        self.raw_bytes = self.path.read_bytes()

    def tearDown(self):
        self.temp.cleanup()

    def save(self, index, count, replacement, edit_id=None):
        words = sample_transcript()["segments"][0]["words"][index:index + count]
        return transcript_edits.save_edit(self.path, 0, index, words, replacement, edit_id)

    def test_raw_is_unchanged_effective_text_and_timing_change_only_as_requested(self):
        edit = self.save(2, 1, "Isaiah")
        effective, edits, warnings = transcript_edits.load_effective_transcript(self.path)
        self.assertEqual(self.path.read_bytes(), self.raw_bytes)
        self.assertEqual(effective["segments"][0]["text"], "The prophet Isaiah said.")
        self.assertEqual(effective["segments"][0]["words"][2]["start"], 1.6)
        self.assertEqual(effective["segments"][0]["words"][2]["end"], 2.1)
        self.assertEqual(edit["affected_start"], 1.6)
        self.assertEqual(edit["affected_end"], 2.1)
        self.assertTrue(edit["timing_needs_alignment"])
        self.assertEqual(edits, [edit])
        self.assertEqual(warnings, [])
        self.assertEqual([w.text for w in captions.words_in_range(effective, 0, 4)],
                         ["The", "prophet", "Isaiah", "said."])
        self.assertIn("Isaiah", captions.generate_ass(captions.words_in_range(effective, 0, 4)))

    def test_phrase_multiple_edits_and_revert(self):
        first = self.save(1, 2, "wise teacher")
        self.save(3, 1, "spoke.")
        effective, _, _ = transcript_edits.load_effective_transcript(self.path)
        self.assertEqual(effective["segments"][0]["text"], "The wise teacher spoke.")
        self.assertTrue(transcript_edits.delete_edit(self.path, first["id"]))
        effective, _, _ = transcript_edits.load_effective_transcript(self.path)
        self.assertEqual(effective["segments"][0]["text"], "The prophet Ezekiel spoke.")
        self.assertEqual(self.path.read_bytes(), self.raw_bytes)

    def test_update_and_clip_selection_view_use_effective_text_without_api_call(self):
        from app.services.clip_selection import _segment_view
        edit = self.save(2, 1, "Isaiah")
        self.save(2, 1, "Jeremiah", edit["id"])
        effective, _, _ = transcript_edits.load_effective_transcript(self.path)
        self.assertIn("Jeremiah", _segment_view(effective))
        self.assertNotIn("Isaiah", _segment_view(effective))
        self.assertEqual(self.path.read_bytes(), self.raw_bytes)

    def test_phrase_with_different_word_count_keeps_original_slots(self):
        self.save(1, 2, "teacher")
        effective, _, _ = transcript_edits.load_effective_transcript(self.path)
        words = effective["segments"][0]["words"]
        self.assertEqual([w["word"] for w in words], ["The", "teacher", "", "said."])
        self.assertEqual([(w["start"], w["end"]) for w in words],
                         [(w["start"], w["end"]) for w in sample_transcript()["segments"][0]["words"]])

    def test_rejects_stale_overlap_and_empty_text(self):
        stale = sample_transcript()["segments"][0]["words"][2].copy()
        stale["word"] = "Other"
        with self.assertRaises(transcript_edits.EditError):
            transcript_edits.save_edit(self.path, 0, 2, [stale], "Isaiah")
        self.save(2, 1, "Isaiah")
        with self.assertRaises(transcript_edits.EditError):
            self.save(1, 2, "new phrase")
        with self.assertRaises(transcript_edits.EditError):
            self.save(0, 1, "  ")
        self.assertEqual(self.path.read_bytes(), self.raw_bytes)

    def test_stale_sidecar_is_ignored_on_read(self):
        edit = self.save(2, 1, "Isaiah")
        sidecar = transcript_edits.edits_path_for(self.path)
        data = json.loads(sidecar.read_text())
        data["edits"][0]["original_words"][0]["start"] = 99
        sidecar.write_text(json.dumps(data))
        effective, valid, warnings = transcript_edits.load_effective_transcript(self.path)
        self.assertEqual(effective, sample_transcript())
        self.assertEqual(valid, [])
        self.assertTrue(warnings)
        with self.assertRaises(transcript_edits.EditError):
            self.save(0, 1, "A")
        self.assertEqual(edit["corrected_text"], "Isaiah")

    def test_api_reads_effective_words(self):
        from app.routers import sermons
        self.save(2, 1, "Isaiah")
        source = Path(self.temp.name) / "sample.mp4"
        source.touch()
        with patch.object(sermons.settings, "data_sources_dir", Path(self.temp.name)), \
             patch.object(sermons, "transcript_path_for", return_value=self.path):
            words = sermons.get_transcript_words("sample.mp4", 0, 4)
            full = sermons.get_transcript("sample.mp4", 0, 4)
        self.assertEqual(words["words"][2]["text"], "Isaiah")
        self.assertEqual(full["segments"][0]["words"][2]["word"], "Isaiah")
        self.assertEqual(full["segments"][0]["raw_words"][2]["word"], "Ezekiel")


class QualityTests(unittest.TestCase):
    def make_transcript(self, phrases):
        return {"segments": [
            {"id": i, "start": i * 2.0, "end": i * 2.0 + 1.5, "text": text}
            for i, text in enumerate(phrases)
        ]}

    def test_normal_and_short_rhetorical_repetition(self):
        normal = self.make_transcript(["A first thought.", "A second thought.", "A third thought."])
        repeated = self.make_transcript(["We can begin again."] * 3)
        self.assertEqual(transcript_quality.analyze_transcript(normal)["status"], "clean")
        self.assertEqual(transcript_quality.analyze_transcript(repeated)["status"], "clean")

    def test_catastrophic_repetition_and_stalled_timestamps(self):
        loop = self.make_transcript(["A repeated synthetic phrase.", "Another synthetic phrase."] * 600)
        report = transcript_quality.analyze_transcript(loop)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["findings"][0]["reason"], "repeated_phrase_loop")
        stalled = self.make_transcript([f"Distinct synthetic phrase {i}." for i in range(12)])
        for segment in stalled["segments"]:
            segment["start"] = 0.0
        self.assertEqual(transcript_quality.analyze_transcript(stalled)["status"], "warning")

    def test_long_near_identical_loop_is_detected(self):
        base = "This is a deliberately long synthetic phrase repeated in the sample transcript"
        phrases = [base + (" today." if i % 2 else " now.") for i in range(30)]
        report = transcript_quality.analyze_transcript(self.make_transcript(phrases))
        self.assertEqual(report["status"], "failed")


if __name__ == "__main__":
    unittest.main()
