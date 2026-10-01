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
        styles = {item["key"]: item for item in response["styles"]}
        self.assertEqual(list(styles), ["classic", "neon_pop", "block", "white_block", "word_pop"])
        expected = {
            "classic": (90, "#FFFFFF", "#FFFF00", 5, 2, 110, "bottom", 500, 3, 22, False),
            "neon_pop": (96, "#FFFFFF", "#FF69B4", 6, 3, 130, "bottom", 600, 3, 22, False),
            "block": (80, "#FFFFFF", "#FFFF00", 2, 0, 110, "bottom", 480, 3, 20, True),
            "white_block": (80, "#000000", "#FF0000", 0, 0, 110, "bottom", 480, 3, 20, True),
            "word_pop": (140, "#FFFFFF", "#FFFF00", 8, 4, 100, "middle", 0, 1, 20, False),
        }
        fields = ("font_size", "primary_color", "highlight_color", "outline_width",
                  "shadow_depth", "highlight_scale", "vertical_anchor", "margin_v",
                  "max_words_per_chunk", "max_chars_per_chunk", "background_box")
        for key, values in expected.items():
            with self.subTest(style=key):
                descriptor = styles[key]
                self.assertEqual(descriptor["schema_version"], 1)
                self.assertEqual(descriptor["font_name"], "DejaVu Sans")
                self.assertEqual(descriptor["outline_color"], "#000000")
                self.assertEqual(tuple(descriptor[field] for field in fields), values)
                self.assertEqual(descriptor["font_weight"], 900 if key == "word_pop" else 800)
                self.assertIn("background_color", descriptor)
                self.assertIn("background_opacity", descriptor)
        self.assertEqual(styles["block"]["background_opacity"], 191 / 255)
        self.assertEqual(styles["white_block"]["background_opacity"], 239 / 255)
        self.assertEqual(styles["classic"]["preview_highlight_color"], "#FFD700")
        self.assertEqual(styles["word_pop"]["preview_highlight_color"], "#FFFFFF")

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
        self.assertIn("&H00B469FF", neon)  # RGB pink converted to ASS BGR
        self.assertIn("Style: Default,DejaVu Sans,96,&H00FFFFFF", neon)
        self.assertIn(",1,6,3,2,80,80,600,1", neon)
        block = generate_ass(words, style="block")
        self.assertIn(r"\1c&H000000&\1a&H40&", block)
        white = generate_ass(words, style="white_block")
        self.assertIn(r"\1c&HFFFFFF&\1a&H10&", white)
        self.assertIn(",2,80,80,777,1", generate_ass(words, style="classic", caption_margin_v=777))

    def test_absent_defaults_and_explicit_unknown_fails(self):
        self.assertIs(get_style(None), get_style("classic"))
        self.assertIs(get_style(""), get_style("classic"))
        with self.assertRaisesRegex(ValueError, "unknown caption style"):
            get_style("missing-style")


if __name__ == "__main__":
    unittest.main()
