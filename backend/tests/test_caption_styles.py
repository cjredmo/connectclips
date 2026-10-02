"""Built-in descriptor and ASS compatibility tests using synthetic words."""

import json
import unittest

from app.main import caption_styles
from app.services.captions import Word, chunk_words, generate_ass, get_style


class CaptionStyleTests(unittest.TestCase):
    def test_all_builtin_descriptors_preserve_values_and_api_shape(self):
        response = caption_styles()
        self.assertEqual(json.loads(json.dumps(response)), response)
        self.assertEqual(response["default"], "classic")
        styles = {item["key"]: item for item in response["styles"] if item["built_in"]}
        self.assertEqual(list(styles), ["classic", "neon_pop", "block", "white_block", "word_pop"])
        expected = {
            "classic": (92, "#FFFFFF", "#F8DA70", 4, 1, 108, "bottom", 500, 3, 20, False),
            "neon_pop": (98, "#FFFFFF", "#FF5BA7", 4, 2, 124, "bottom", 550, 3, 20, False),
            "block": (82, "#FFFFFF", "#FFD86B", 1, 0, 106, "bottom", 480, 3, 20, True),
            "white_block": (82, "#18293B", "#A53A38", 0, 0, 106, "bottom", 480, 3, 20, True),
            "word_pop": (132, "#FFFFFF", "#FDE68A", 5, 2, 100, "middle", 0, 1, 20, False),
        }
        fields = ("font_size", "primary_color", "highlight_color", "outline_width",
                  "shadow_depth", "highlight_scale", "vertical_anchor", "margin_v",
                  "max_words_per_chunk", "max_chars_per_chunk", "background_box")
        for key, values in expected.items():
            with self.subTest(style=key):
                descriptor = styles[key]
                self.assertEqual(descriptor["schema_version"], 2)
                self.assertEqual(descriptor["presentation_mode"],
                                 "single_word" if key == "word_pop" else "progressive_chunk")
                self.assertTrue(descriptor["built_in"])
                self.assertFalse(descriptor["editable"])
                self.assertEqual(descriptor["font_name"], "DejaVu Sans")
                self.assertEqual(descriptor["outline_color"], "#000000")
                self.assertEqual(tuple(descriptor[field] for field in fields), values)
                self.assertEqual(descriptor["font_weight"], 900 if key == "word_pop" else 800)
                self.assertIn("background_color", descriptor)
                self.assertIn("background_opacity", descriptor)
                self.assertEqual(descriptor["background_persistence"], "speech")
                self.assertEqual(descriptor["background_linger_seconds"], 1.0)
        self.assertEqual(styles["block"]["background_opacity"], .82)
        self.assertEqual(styles["white_block"]["background_opacity"], .94)
        self.assertTrue(all(style["preview_highlight_color"] is None and
                            style["preview_background_opacity"] is None
                            for style in styles.values()))

    def test_chunk_presentation_and_progressive_ass_are_unchanged(self):
        words = [Word("Hello", 0, 0.3), Word("there", 0.3, 0.6),
                 Word("friend.", 0.6, 0.9)]
        for key in ("classic", "neon_pop", "block", "white_block"):
            with self.subTest(style=key):
                self.assertEqual([len(chunk) for chunk in chunk_words(words, get_style(key))], [3])
        self.assertEqual([len(chunk) for chunk in chunk_words(words, get_style("word_pop"))],
                         [1, 1, 1])
        self.assertEqual(generate_ass(words, style="classic").count("Dialogue:"), 3)
        self.assertIn(r"\alpha&HFF&", generate_ass(words, style="classic"))

    def test_ass_conversion_and_position_override(self):
        words = [Word("Sample", 0, 0.4)]
        neon = generate_ass(words, style="neon_pop")
        self.assertIn("&H00A75BFF", neon)  # RGB pink converted to ASS BGR
        self.assertIn("Style: Default,DejaVu Sans,98,&H00FFFFFF", neon)
        self.assertIn(",1,4,2,2,80,80,550,1", neon)
        block = generate_ass(words, style="block")
        self.assertIn(r"\1c&H2E2013&\1a&H2E&", block)
        white = generate_ass(words, style="white_block")
        self.assertIn(r"\1c&HEAF3F7&\1a&H0F&", white)
        self.assertIn(",2,80,80,777,1", generate_ass(words, style="classic", caption_margin_v=777))
        self.assertIn(",2,80,80,777,1", generate_ass(words, style="word_pop", caption_margin_v=777))

    def test_absent_defaults_and_explicit_unknown_fails(self):
        self.assertIs(get_style(None), get_style("classic"))
        self.assertIs(get_style(""), get_style("classic"))
        with self.assertRaisesRegex(ValueError, "unknown caption style"):
            get_style("missing-style")


if __name__ == "__main__":
    unittest.main()
