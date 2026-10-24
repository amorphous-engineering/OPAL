"""Build identification (opal.version) tests."""

from packaging.version import Version

import opal
from opal.version import VersionInfo, get_version_info


def test_release_build_is_plain_version():
    info = VersionInfo(base="1.3.2")
    assert not info.is_dev
    assert info.full == "1.3.2"
    assert info.display == "v1.3.2"
    assert info.tooltip == "Release v1.3.2"


def test_dev_build_includes_branch_commit_dirty():
    info = VersionInfo(base="1.3.2", branch="devel", commit="6befb6f", dirty=True)
    assert info.is_dev
    assert info.full == "1.3.2+devel.6befb6f.dirty"
    assert info.display == "v1.3.2+devel.6befb6f.dirty"
    assert "devel @ 6befb6f" in info.tooltip
    assert "uncommitted" in info.tooltip


def test_branch_names_are_sanitized_for_pep440():
    info = VersionInfo(base="1.3.2", branch="claude/fix_thing-2", commit="abc1234")
    assert info.full == "1.3.2+claude.fix.thing.2.abc1234"


def test_detached_head_omits_branch():
    info = VersionInfo(base="1.3.2", commit="abc1234")
    assert info.full == "1.3.2+abc1234"
    assert "detached HEAD" in info.tooltip


def test_full_version_is_pep440_parseable():
    info = VersionInfo(base="1.3.2", branch="devel", commit="6befb6f", dirty=True)
    parsed = Version(info.full)
    # Local segment must not affect release ordering (updater relies on this).
    assert parsed.release == (1, 3, 2)
    assert Version("1.3.3") > parsed


def test_get_version_info_base_matches_package_version():
    info = get_version_info()
    assert info.base == opal.__version__
    # Test runs happen in a git checkout, so this is a dev build.
    assert info.is_dev
    assert info.commit
