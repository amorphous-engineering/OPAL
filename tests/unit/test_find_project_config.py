"""Config discovery is cwd-only — the worktree-ambush regression test."""

from opal.project import find_project_config


def test_yaml_in_parent_is_not_found(tmp_path):
    """A config above the instance directory must never be picked up."""
    (tmp_path / "opal.project.yaml").write_text("name: Ambush\n")
    child = tmp_path / "child" / "grandchild"
    child.mkdir(parents=True)

    assert find_project_config(child) is None


def test_yaml_in_start_dir_is_found(tmp_path):
    config = tmp_path / "opal.project.yaml"
    config.write_text("name: Here\n")

    assert find_project_config(tmp_path) == config


def test_no_yaml_returns_none(tmp_path):
    assert find_project_config(tmp_path) is None
