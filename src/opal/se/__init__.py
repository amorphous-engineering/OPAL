"""Systems engineering module: requirements, lifecycle/baseline machinery.

Design intent: SE best practice is enforced through the data model and
mechanical checks, not prose conventions. Documents (requirement specs,
VCRM, ICDs) are generated views over the traceability graph, never
hand-maintained artifacts. No mandatory ceremony: projects that don't
enable SE features never see them.

Scoping assumption (recorded decision): one OPAL instance = one project.
There is no project_id anywhere in the SE schema; multi-project means
multiple database files. Requirement numbers go through the designator
system (system-unique, never reused) so a future cross-database import
is a collision-free problem.
"""

from opal.se.lifecycle import LifecycleError, baseline, cancel, ensure_mutable, revise

__all__ = ["LifecycleError", "baseline", "cancel", "ensure_mutable", "revise"]
