"""Risk model — scenario-structured per NASA/SP-2011-3422 §4.2.1.1.

A risk is a four-part scenario (condition / departure / asset / consequence);
the prose statement is generated from the parts, never stored. Dispositions
are the CRM Plan-step set. Transition rules and acceptance enforcement live
in opal.risks, not the database layer — columns here are nullable so rows
predating the scenario structure survive; requirements gate transitions.
"""

from datetime import datetime
from enum import Enum

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from opal.db.base import Base, IdMixin, SoftDeleteMixin, TimestampMixin


class RiskDisposition(str, Enum):
    """CRM dispositions (NASA's set, adapted; elevate deliberately omitted).

    Freely changeable except accepted -> * (requires a note; un-accepting a
    signed risk is itself auditable) and realized (terminal).
    """

    OPEN = "open"
    MITIGATE = "mitigate"
    WATCH = "watch"
    RESEARCH = "research"
    ACCEPTED = "accepted"
    CLOSED = "closed"
    REALIZED = "realized"


class RiskIssueRole(str, Enum):
    """What a linked issue is to the risk."""

    MITIGATION = "mitigation"
    RESEARCH = "research"


def severity_for(score: int) -> str:
    """Severity bucket for a 1-25 score: 1-5 low, 6-12 medium, 13-25 high."""
    if score <= 5:
        return "low"
    elif score <= 12:
        return "medium"
    return "high"


class Risk(Base, IdMixin, TimestampMixin, SoftDeleteMixin):
    """Scenario-structured risk with probability x impact scoring.

    title is the short handle; description is the NARRATIVE (context,
    evidence, suggested responses). Responses themselves are linked Issues
    (RiskIssueLink) — never embedded task lists.
    """

    risk_number: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        unique=True,
        index=True,
        comment="Human-readable risk ID (e.g., RISK-00001)",
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="Narrative: context, evidence, suggested responses"
    )

    # Scenario — the four parts. The statement property is the only prose form.
    condition: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="Present-tense fact, independently checkable now"
    )
    departure: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="Undesired future event — probability scores this"
    )
    asset_part_id: Mapped[int | None] = mapped_column(
        ForeignKey("part.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
        comment="Exposed asset when it is hardware (else asset_text; exactly one set)",
    )
    asset_text: Mapped[str | None] = mapped_column(
        String(255), nullable=True, comment='Exposed asset when not hardware ("schedule", ...)'
    )
    consequence: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="Credible measurable impact — impact scores this"
    )

    disposition: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=RiskDisposition.OPEN.value,
        server_default=RiskDisposition.OPEN.value,
        index=True,
    )
    owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Scoring: 1-5 each, score = probability x impact
    probability: Mapped[int] = mapped_column(
        Integer, nullable=False, default=3, comment="1-5 scale"
    )
    impact: Mapped[int] = mapped_column(Integer, nullable=False, default=3, comment="1-5 scale")
    residual_probability: Mapped[int | None] = mapped_column(
        Integer, nullable=True, comment="1-5 scale, post-response target"
    )
    residual_impact: Mapped[int | None] = mapped_column(
        Integer, nullable=True, comment="1-5 scale, post-response target"
    )

    # Acceptance — the signature. Covers the risk as scored: scenario or score
    # changes after acceptance re-disposition the risk to open (opal.risks).
    accepted_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    acceptance_rationale: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Watch disposition fields
    watch_observable: Mapped[str | None] = mapped_column(String(255), nullable=True)
    watch_threshold: Mapped[str | None] = mapped_column(String(255), nullable=True)
    watch_contingency: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Register review stamp — the entire review-board ceremony
    last_reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_reviewed_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )

    # Afterlife: a realized risk's departure happened — it lives on as an issue
    realized_issue_id: Mapped[int | None] = mapped_column(
        ForeignKey("issue.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Relationships
    owner: Mapped["User | None"] = relationship("User", foreign_keys=[owner_id])
    accepted_by: Mapped["User | None"] = relationship("User", foreign_keys=[accepted_by_id])
    last_reviewed_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[last_reviewed_by_id]
    )
    asset_part: Mapped["Part | None"] = relationship("Part", foreign_keys=[asset_part_id])
    realized_issue: Mapped["Issue | None"] = relationship(
        "Issue", foreign_keys=[realized_issue_id]
    )
    issue_links: Mapped[list["RiskIssueLink"]] = relationship(
        "RiskIssueLink", back_populates="risk", cascade="all, delete-orphan"
    )
    references: Mapped[list["RiskReference"]] = relationship(
        "RiskReference", back_populates="risk", cascade="all, delete-orphan"
    )

    @property
    def score(self) -> int:
        """Calculate risk score (probability x impact)."""
        return self.probability * self.impact

    @property
    def severity(self) -> str:
        """Severity level of the current score."""
        return severity_for(self.score)

    @property
    def residual_score(self) -> int | None:
        """Post-response target score, or None until both residuals are set."""
        if self.residual_probability is None or self.residual_impact is None:
            return None
        return self.residual_probability * self.residual_impact

    @property
    def residual_severity(self) -> str | None:
        """Severity level of the residual score."""
        score = self.residual_score
        return severity_for(score) if score is not None else None

    @property
    def asset_display(self) -> str | None:
        """The exposed asset as prose: part name (PN) when hardware, else asset_text."""
        if self.asset_part is not None:
            part = self.asset_part
            return f"{part.name} ({part.internal_pn})" if part.internal_pn else part.name
        return self.asset_text

    @property
    def scenario_complete(self) -> bool:
        """All four scenario parts present, with exactly one asset form set."""
        has_asset = (self.asset_part_id is not None) != bool((self.asset_text or "").strip())
        return bool(
            (self.condition or "").strip()
            and (self.departure or "").strip()
            and has_asset
            and (self.consequence or "").strip()
        )

    @property
    def statement(self) -> str | None:
        """The generated NASA-format risk statement — a view, never a column.

        None until the scenario is complete; the detail page shows the
        masthead only when there is a real statement to show.
        """
        if not self.scenario_complete:
            return None
        condition = self.condition.strip().rstrip(".")
        departure = self.departure.strip().rstrip(".")
        consequence = self.consequence.strip().rstrip(".")
        return (
            f"Given that {condition}, there is a possibility of {departure} "
            f"adversely impacting {self.asset_display}, thereby leading to {consequence}."
        )

    def __repr__(self) -> str:
        return f"<Risk(id={self.id}, title='{self.title}', score={self.score})>"


class RiskIssueLink(Base, IdMixin, TimestampMixin):
    """A response linked to a risk — Issues are OPAL's only action tracker.

    A mitigation is real when it has an issue with an owner; it completes
    when the issue closes. role distinguishes mitigation work from research
    (uncertainty-reduction) work.
    """

    __table_args__ = (UniqueConstraint("risk_id", "issue_id", name="uq_risk_issue_link"),)

    risk_id: Mapped[int] = mapped_column(
        ForeignKey("risk.id", ondelete="CASCADE"), nullable=False, index=True
    )
    issue_id: Mapped[int] = mapped_column(
        ForeignKey("issue.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=RiskIssueRole.MITIGATION.value,
        server_default=RiskIssueRole.MITIGATION.value,
    )

    risk: Mapped["Risk"] = relationship("Risk", back_populates="issue_links")
    issue: Mapped["Issue"] = relationship("Issue", back_populates="risk_links")

    def __repr__(self) -> str:
        return f"<RiskIssueLink(risk_id={self.risk_id}, issue_id={self.issue_id}, role={self.role})>"
