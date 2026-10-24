"""Health endpoint tests."""

from opal.version import get_version_info


def test_health_check(client):
    """Health endpoint reports status and the identity of the running build."""
    response = client.get("/api/health")
    assert response.status_code == 200

    data = response.json()
    info = get_version_info()
    assert data["status"] == "healthy"
    assert data["version"] == info.full
    assert data["branch"] == info.branch
    assert data["commit"] == info.commit
    assert data["dirty"] == info.dirty
