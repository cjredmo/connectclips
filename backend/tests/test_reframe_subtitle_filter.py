"""Regression checks for subtitle paths passed to FFmpeg export commands."""

import io
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from app.services import reframe


class FakeProcess:
    def __init__(self):
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO(b"progress=end\n")
        self.stderr = io.BytesIO()
        self.returncode = 0

    def wait(self):
        return self.returncode


class FakeContainer:
    def decode(self, **_kwargs):
        return iter(())

    def close(self):
        pass


class SubtitleFilterTests(unittest.TestCase):
    def test_posix_absolute_path(self):
        self.assertEqual(
            reframe._subtitle_filter(Path("/tmp/captions.ass")),
            "subtitles=filename='/tmp/captions.ass'",
        )

    def test_windows_drive_letter_and_spaces(self):
        self.assertEqual(
            reframe._subtitle_filter(Path(r"C:\Church Clips\captions.ass")),
            r"subtitles=filename='C\:/Church Clips/captions.ass'",
        )

    def test_face_tracked_export_passes_explicit_filename(self):
        commands = []

        def popen(cmd, **_kwargs):
            commands.append(cmd)
            return FakeProcess()

        with patch.object(reframe.subprocess, "Popen", side_effect=popen), \
             patch.object(reframe.av, "open", return_value=FakeContainer()):
            reframe._encode(
                Path("clip.mp4"), np.zeros((1, 3)), 1920, 1080, 30,
                Path("out.mp4"), Path("/tmp/Church Clips/captions.ass"),
            )

        cmd = commands[0]
        self.assertEqual(
            cmd[cmd.index("-vf") + 1],
            "subtitles=filename='/tmp/Church Clips/captions.ass'",
        )

    def test_stage_export_passes_explicit_filename(self):
        commands = []

        def popen(cmd, **_kwargs):
            commands.append(cmd)
            return FakeProcess()

        with patch.object(reframe.subprocess, "Popen", side_effect=popen):
            reframe._encode_stage(
                Path("clip.mp4"), Path("out.mp4"),
                Path("/tmp/Church Clips/captions.ass"),
            )

        cmd = commands[0]
        self.assertIn(
            "[composite]subtitles=filename='/tmp/Church Clips/captions.ass'[v]",
            cmd[cmd.index("-filter_complex") + 1],
        )


if __name__ == "__main__":
    unittest.main()
