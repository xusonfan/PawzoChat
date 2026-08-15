from pawzochat.utils.persona_sort import persona_sort_metadata


def test_persona_sort_metadata_uses_pinyin_initial():
    assert persona_sort_metadata("阿澈") == ("ache", "A")
    assert persona_sort_metadata("林栀") == ("linzhi", "L")
    assert persona_sort_metadata("小晚") == ("xiaowan", "X")


def test_persona_sort_metadata_groups_non_letters_under_hash():
    assert persona_sort_metadata("123")[1] == "#"
    assert persona_sort_metadata("🌙小晚")[1] == "#"