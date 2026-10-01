"""Progressive caption visibility without changing chunk timing or layout."""

import re
import unittest

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
        for event, states in zip(first_chunk, expected_states):
            text = event[9]
            # Every Dialogue retains all three words in order, including the
            # invisible ones, so libass lays out the complete centered line.
            self.assertEqual(re.findall(r"From|top|to\.", text), ["From", "top", "to."])
            actual_states = []
            for tag, word in re.findall(r"\{([^}]*)\}(From|top|to\.)", text):
                if r"\alpha&HFF&" in tag:
                    actual_states.append("future")
                elif r"\c&H0000FFFF" in tag and r"\alpha&H00&" in tag:
                    actual_states.append("current")
                elif r"\alpha&H00&" in tag:
                    actual_states.append("spoken")
            self.assertEqual(tuple(actual_states), states)
            self.assertEqual(text.count(r"\fscx110\fscy110"), 1)

        self.assertEqual(events[3][1:3], ["0:00:01.50", "0:00:01.90"])


if __name__ == "__main__":
    unittest.main()
