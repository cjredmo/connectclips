"""Progressive caption visibility without changing chunk timing or layout."""

import re
import unittest
from dataclasses import replace

from app.services.captions import Word, chunk_words, generate_ass, get_style


WORDS = [
    Word("From", 0.0, 0.4),
    Word("top", 0.5, 0.9),
    Word("to.", 1.0, 1.4),
    Word("Next", 1.5, 1.9),
]


class ProgressiveCaptionTests(unittest.TestCase):
    def test_chunk_boundaries_are_preserved(self):
        self.assertEqual(
            [[word.text for word in chunk] for chunk in chunk_words(WORDS, get_style("classic"))],
            [["From", "top", "to."], ["Next"]],
        )

    def test_each_word_reveals_at_its_start_with_full_chunk_layout(self):
        ass = generate_ass(WORDS, style="classic")
        events = [line.split(",", 9) for line in ass.splitlines() if line.startswith("Dialogue:")]
        first_chunk = events[:3]

        self.assertEqual(
            [(event[1], event[2]) for event in first_chunk],
            [("0:00:00.00", "0:00:00.50"),
             ("0:00:00.50", "0:00:01.00"),
             ("0:00:01.00", "0:00:01.40")],
        )

        expected_states = [
            ("current", "future", "future"),
            ("spoken", "current", "future"),
            ("spoken", "spoken", "current"),
        ]
        style = get_style("classic")
        color = style.highlight_color
        active_color = rf"\c&H00{color[5:7]}{color[3:5]}{color[1:3]}"
        for event, states in zip(first_chunk, expected_states):
            text = event[9]
            # Every Dialogue retains all three words in order, including the
            # invisible ones, so libass lays out the complete centered line.
            self.assertEqual(re.findall(r"From|top|to\.", text), ["From", "top", "to."])
            actual_states = []
            for tag, word in re.findall(r"\{([^}]*)\}(From|top|to\.)", text):
                if r"\alpha&HFF&" in tag:
                    actual_states.append("future")
                elif active_color in tag and r"\alpha&H00&" in tag:
                    actual_states.append("current")
                elif r"\alpha&H00&" in tag:
                    actual_states.append("spoken")
            self.assertEqual(tuple(actual_states), states)
            self.assertEqual(text.count(rf"\fscx{style.highlight_scale}\fscy{style.highlight_scale}"), 1)

        self.assertEqual(events[3][1:3], ["0:00:01.50", "0:00:01.90"])

    def test_background_continuity_does_not_extend_progressive_text(self):
        words = [Word("One", 0, .2), Word("two", .3, .5),
                 Word("three", .7, .9), Word("Four", 1.6, 1.8)]
        progressive = replace(get_style("white_block"), max_words_per_chunk=2)
        ass = generate_ass(words, style=progressive)
        events = [line.split(",", 9) for line in ass.splitlines()
                  if line.startswith("Dialogue:")]
        boxes = [event for event in events if event[0] == "Dialogue: 0"]
        text = [event for event in events if event[0] == "Dialogue: 1"]
        self.assertEqual([event[1:3] for event in boxes], [
            ["0:00:00.00", "0:00:00.90"],
            ["0:00:01.60", "0:00:01.80"],
        ])
        self.assertEqual(text[1][1:3], ["0:00:00.30", "0:00:00.50"])
        self.assertIn(r"\alpha&HFF&", text[0][9])

        single = replace(progressive, presentation_mode="single_word")
        events = [line.split(",", 9) for line in generate_ass(words, style=single).splitlines()
                  if line.startswith("Dialogue:")]
        boxes = [event for event in events if event[0] == "Dialogue: 0"]
        text = [event for event in events if event[0] == "Dialogue: 1"]
        self.assertEqual(boxes[0][1:3], ["0:00:00.00", "0:00:00.90"])
        self.assertEqual(boxes[1][1:3], ["0:00:01.60", "0:00:01.80"])
        self.assertEqual(text[0][2], "0:00:00.20")

        full = replace(progressive, presentation_mode="full_chunk_highlight")
        events = [line.split(",", 9) for line in generate_ass(words, style=full,
                   clip_duration=2).splitlines() if line.startswith("Dialogue:")]
        boxes = [event for event in events if event[0] == "Dialogue: 0"]
        text = [event for event in events if event[0] == "Dialogue: 1"]
        self.assertEqual([event[1:3] for event in boxes],
                         [["0:00:00.00", "0:00:02.00"]])
        self.assertEqual(text[1][2], "0:00:00.70")
        self.assertNotIn(r"\alpha&HFF&", "\n".join(event[9] for event in text))
        self.assertEqual(generate_ass(words, style="classic").count("Dialogue:"), 4)

    def test_background_persistence_changes_only_box_events(self):
        words = [Word("One", .2, .4), Word("Two", 1.0, 1.2),
                 Word("Three", 3.0, 3.2)]
        base = replace(get_style("white_block"), presentation_mode="single_word")

        def layers(style):
            events = [line.split(",", 9) for line in generate_ass(
                words, style=style, clip_duration=3.5).splitlines()
                if line.startswith("Dialogue:")]
            return ([event[1:3] for event in events if event[0] == "Dialogue: 0"],
                    [event for event in events if event[0] == "Dialogue: 1"])

        speech_boxes, speech_text = layers(base)
        self.assertEqual(speech_boxes, [["0:00:00.20", "0:00:00.40"],
                                        ["0:00:01.00", "0:00:01.20"],
                                        ["0:00:03.00", "0:00:03.20"]])
        linger_boxes, linger_text = layers(replace(
            base, background_persistence="linger", background_linger_seconds=1))
        self.assertEqual(linger_boxes, [["0:00:00.20", "0:00:02.20"],
                                        ["0:00:03.00", "0:00:03.50"]])
        clip_boxes, clip_text = layers(replace(base, background_persistence="clip"))
        self.assertEqual(clip_boxes, [["0:00:00.00", "0:00:03.50"]])
        self.assertEqual(speech_text, linger_text)
        self.assertEqual(speech_text, clip_text)
        self.assertEqual([event[1:3] for event in speech_text],
                         [["0:00:00.20", "0:00:00.40"],
                          ["0:00:01.00", "0:00:01.20"],
                          ["0:00:03.00", "0:00:03.20"]])

    def test_full_clip_box_without_words(self):
        style = replace(get_style("white_block"), background_persistence="clip")
        events = [line for line in generate_ass([], style=style, clip_duration=2).splitlines()
                  if line.startswith("Dialogue:")]
        self.assertEqual(len(events), 1)
        self.assertIn("Dialogue: 0,0:00:00.00,0:00:02.00", events[0])


if __name__ == "__main__":
    unittest.main()
