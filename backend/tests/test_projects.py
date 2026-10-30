import json

import pytest

from promo_server import projects


def test_default_project_is_the_root_and_new_ones_get_unique_ids(tmp_path):
    (tmp_path / "session.promo.json").write_text(json.dumps({"clips": [{}, {}]}))
    assert projects.current_project(tmp_path) == "default"
    a = projects.create_project(tmp_path, "Summer Tour '27")
    b = projects.create_project(tmp_path, "Summer tour 27")
    assert a == "summer-tour-27" and b == "summer-tour-27-2"
    listed = {p["id"]: p for p in projects.list_projects(tmp_path)}
    assert listed["default"]["clips"] == 2 and listed["default"]["name"] == "Default"
    assert listed[a]["name"] == "Summer Tour '27" and listed[a]["clips"] == 0


def test_save_as_copies_session_and_slices_but_not_temp_text_tracks(tmp_path):
    src = tmp_path / "projects" / "src"
    (src / ".cache" / "text" / "abc").mkdir(parents=True)
    (src / "session.promo.json").write_text('{"clips": []}')
    (src / ".cache" / "c_001.mp4").write_bytes(b"x")
    pid = projects.create_project(tmp_path, "Copy", copy_from=src)
    dest = projects.project_path(tmp_path, pid)
    assert (dest / "session.promo.json").exists() and (dest / ".cache" / "c_001.mp4").exists()
    assert not (dest / ".cache" / "text").exists()


def test_current_project_survives_restart_and_falls_back_if_deleted(tmp_path):
    pid = projects.create_project(tmp_path, "One")
    projects.set_current_project(tmp_path, pid)
    assert projects.current_project(tmp_path) == pid
    projects.project_path(tmp_path, pid).rename(tmp_path / "gone")
    assert projects.current_project(tmp_path) == "default"


def test_rejects_path_tricks_and_empty_names(tmp_path):
    with pytest.raises(ValueError):
        projects.project_path(tmp_path, "../etc")
    with pytest.raises(ValueError):
        projects.create_project(tmp_path, "   ")
