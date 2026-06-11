"""Risks screen - view and manage risks."""

from typing import Any

from textual.app import ComposeResult
from textual.containers import Container, Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import Button, DataTable, Input, Label, Select, Static, TextArea

from opal.tui.api_client import get_client
from opal.tui.widgets.form import FormGroup, FormModal


class RiskFormModal(FormModal):
    """Modal form for creating/editing a risk."""

    def __init__(self, risk: dict[str, Any] | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.risk = risk

    @property
    def form_title(self) -> str:
        return "Edit Risk" if self.risk else "New Risk"

    def build_form(self) -> ComposeResult:
        title_val = self.risk.get("title", "") if self.risk else ""
        desc_val = self.risk.get("description", "") if self.risk else ""

        yield FormGroup(
            "Title",
            Input(value=title_val, id="field-title", placeholder="Risk title"),
            required=True,
        )

        prob_options = [(str(i), str(i)) for i in range(1, 6)]
        current_prob = str(self.risk.get("probability", 3)) if self.risk else "3"
        yield FormGroup(
            "Probability (1-5)",
            Select(prob_options, id="field-probability", value=current_prob),
            required=True,
        )

        impact_options = [(str(i), str(i)) for i in range(1, 6)]
        current_impact = str(self.risk.get("impact", 3)) if self.risk else "3"
        yield FormGroup(
            "Impact (1-5)",
            Select(impact_options, id="field-impact", value=current_impact),
            required=True,
        )

        yield FormGroup(
            "Description",
            TextArea(text=desc_val, id="field-description"),
        )

    def get_form_data(self) -> dict[str, Any] | None:
        title = self.query_one("#field-title", Input).value.strip()
        if not title:
            self.show_error("Title is required")
            return None

        probability = self.query_one("#field-probability", Select).value
        impact = self.query_one("#field-impact", Select).value
        description = self.query_one("#field-description", TextArea).text.strip()

        return {
            "title": title,
            "probability": int(probability) if probability != Select.BLANK else 3,
            "impact": int(impact) if impact != Select.BLANK else 3,
            "description": description,
        }


class RiskDetail(Static):
    """Risk detail panel."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.risk_data: dict[str, Any] | None = None

    def compose(self) -> ComposeResult:
        yield Label("Risk Details", classes="section-title")
        yield Container(id="risk-detail-content")

    def show_risk(self, risk: dict[str, Any]) -> None:
        """Display risk details."""
        self.risk_data = risk
        content = self.query_one("#risk-detail-content", Container)
        content.remove_children()

        content.mount(Label(f"Risk #: {risk.get('risk_number', '-')}", classes="detail-row"))
        content.mount(Label(f"Title: {risk.get('title', '-')}", classes="detail-row"))

        disposition = risk.get("disposition", "-")
        content.mount(
            Label(f"Disposition: {disposition}", classes=f"detail-row status-{disposition}")
        )

        # Risk scoring
        probability = risk.get("probability", 0)
        impact = risk.get("impact", 0)
        score = risk.get("score", 0)
        severity = risk.get("severity", "unknown")

        content.mount(Label(f"Probability: {probability}/5", classes="detail-row"))
        content.mount(Label(f"Impact: {impact}/5", classes="detail-row"))
        content.mount(
            Label(f"Score: {score} ({severity.upper()})", classes=f"detail-row risk-{severity}")
        )

        residual_score = risk.get("residual_score")
        if residual_score is not None:
            residual_severity = risk.get("residual_severity", "unknown") or "unknown"
            content.mount(
                Label(
                    f"Residual: {residual_score} ({residual_severity.upper()})",
                    classes=f"detail-row risk-{residual_severity}",
                )
            )

        # Description
        description = risk.get("description", "")
        if description:
            content.mount(Label("Description:", classes="detail-label"))
            content.mount(Label(description[:200], classes="detail-text"))

        # Owner
        if risk.get("owner_id"):
            owner = risk.get("owner_name") or f"User #{risk['owner_id']}"
            content.mount(Label(f"Owner: {owner}", classes="detail-row"))

        # Linked issues
        linked = risk.get("linked_issues") or []
        if linked:
            summary = ", ".join(
                f"{li.get('issue_number', '?')} ({li.get('role', '?')})" for li in linked
            )
            content.mount(Label(f"Linked Issues: {summary}", classes="detail-row"))
        if risk.get("realized_issue_id"):
            content.mount(
                Label(f"Realized Issue: #{risk['realized_issue_id']}", classes="detail-row")
            )

        # Timestamps
        created = risk.get("created_at", "")[:16] if risk.get("created_at") else "-"
        content.mount(Label(f"Created: {created}", classes="detail-row"))

    def clear(self) -> None:
        """Clear the detail panel."""
        self.risk_data = None
        content = self.query_one("#risk-detail-content", Container)
        content.remove_children()
        content.mount(Label("Select a risk to view details", classes="hint"))


class RiskMatrix(Static):
    """Risk matrix visualization."""

    def compose(self) -> ComposeResult:
        yield Label("Risk Matrix", classes="section-title")
        yield Container(id="matrix-content")

    def show_matrix(self, matrix_data: dict[str, Any]) -> None:
        """Display risk matrix."""
        content = self.query_one("#matrix-content", Container)
        content.remove_children()

        matrix = matrix_data.get("matrix", [])

        # Header row (impact levels)
        header = "     1   2   3   4   5  <- Impact"
        content.mount(Label(header, classes="matrix-header"))

        # Matrix rows (probability levels, from 5 to 1)
        for prob in range(5, 0, -1):
            row_data = matrix[prob - 1] if prob <= len(matrix) else [0] * 5
            cells = " ".join(f"[{c:2d}]" if c > 0 else " .  " for c in row_data)
            content.mount(Label(f"P{prob}: {cells}", classes="matrix-row"))

        content.mount(Label("^ Probability", classes="matrix-footer"))

        # Legend
        total = matrix_data.get("total_risks", 0)
        content.mount(Label(f"Open risks: {total}", classes="matrix-legend"))


class RisksScreen(Screen):
    """Risks list screen."""

    BINDINGS = [
        ("r", "refresh", "Refresh"),
        ("n", "new_risk", "New Risk"),
        ("ctrl+e", "edit_risk", "Edit"),
        ("m", "toggle_matrix", "Matrix"),
        ("escape", "go_back", "Back"),
    ]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.show_matrix = False

    def compose(self) -> ComposeResult:
        yield Vertical(
            Label("Risks", classes="screen-title"),
            Horizontal(
                Button("All", id="filter-all", variant="primary"),
                Button("Open", id="filter-open"),
                Button("Mitigate", id="filter-mitigate"),
                Button("Watch", id="filter-watch"),
                Button("Research", id="filter-research"),
                Button("Accepted", id="filter-accepted"),
                Button("Closed", id="filter-closed"),
                Button("Realized", id="filter-realized"),
                classes="filter-bar",
            ),
            Horizontal(
                Vertical(
                    DataTable(id="risks-table"),
                    classes="table-container",
                ),
                Vertical(
                    RiskDetail(id="risk-detail"),
                    RiskMatrix(id="risk-matrix"),
                    classes="detail-panel",
                ),
                classes="main-content",
            ),
            classes="screen-container",
        )

    async def on_mount(self) -> None:
        """Initialize the risks table."""
        table = self.query_one("#risks-table", DataTable)
        table.add_columns("Risk #", "Title", "P", "I", "Score", "Sev", "Disposition")
        table.cursor_type = "row"
        await self.load_risks()
        await self.load_matrix()

    async def action_refresh(self) -> None:
        """Refresh risks list."""
        await self.load_risks()
        await self.load_matrix()
        self.notify("Risks refreshed")

    def action_go_back(self) -> None:
        """Go back to dashboard."""
        self.app.switch_screen("dashboard")

    async def action_new_risk(self) -> None:
        """Show new risk dialog."""
        self.app.push_screen(RiskFormModal(), callback=self._on_risk_created)

    def _on_risk_created(self, data: dict[str, Any] | None) -> None:
        """Handle risk creation result."""
        if data is None:
            return
        client = get_client(self.app.api_url)
        try:
            risk = client.create_risk(data)
            self.notify(f"Created risk: {risk.get('title', '')}")
            self.run_worker(self.load_risks())
            self.run_worker(self.load_matrix())
        except Exception as e:
            self.notify(f"Error creating risk: {e}", severity="error")

    async def action_edit_risk(self) -> None:
        """Edit the selected risk."""
        detail = self.query_one("#risk-detail", RiskDetail)
        if not detail.risk_data:
            self.notify("Select a risk first", severity="warning")
            return
        self.app.push_screen(
            RiskFormModal(risk=detail.risk_data),
            callback=self._on_risk_edited,
        )

    def _on_risk_edited(self, data: dict[str, Any] | None) -> None:
        """Handle risk edit result."""
        if data is None:
            return
        detail = self.query_one("#risk-detail", RiskDetail)
        if not detail.risk_data:
            return
        client = get_client(self.app.api_url)
        try:
            client.update_risk(detail.risk_data["id"], data)
            self.notify("Risk updated")
            self.run_worker(self.load_risks())
            self.run_worker(self.load_matrix())
        except Exception as e:
            self.notify(f"Error updating risk: {e}", severity="error")

    def action_toggle_matrix(self) -> None:
        """Toggle risk matrix visibility."""
        matrix = self.query_one("#risk-matrix", RiskMatrix)
        matrix.display = not matrix.display
        self.notify("Matrix " + ("shown" if matrix.display else "hidden"))

    async def load_risks(self, disposition: str | None = None) -> None:
        """Load risks from API."""
        client = get_client(self.app.api_url)
        table = self.query_one("#risks-table", DataTable)
        detail = self.query_one("#risk-detail", RiskDetail)

        try:
            result = client.list_risks(disposition=disposition, page_size=100)
            risks = result.get("items", [])

            table.clear()
            for risk in risks:
                table.add_row(
                    risk.get("risk_number", ""),
                    risk.get("title", "")[:30],
                    str(risk.get("probability", 0)),
                    str(risk.get("impact", 0)),
                    str(risk.get("score", 0)),
                    risk.get("severity", "")[:4].upper(),
                    risk.get("disposition", ""),
                    key=str(risk.get("id")),
                )

            detail.clear()

        except Exception as e:
            self.notify(f"Error loading risks: {e}", severity="error")

    async def load_matrix(self) -> None:
        """Load risk matrix data."""
        client = get_client(self.app.api_url)
        matrix_widget = self.query_one("#risk-matrix", RiskMatrix)

        try:
            matrix_data = client.get_risk_matrix()
            matrix_widget.show_matrix(matrix_data)
        except Exception as e:
            self.notify(f"Error loading matrix: {e}", severity="error")

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle filter button clicks."""
        button_id = event.button.id or ""

        if button_id.startswith("filter-"):
            disposition: str | None = button_id.replace("filter-", "")
            if disposition == "all":
                disposition = None
            await self.load_risks(disposition=disposition)

    async def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Handle row selection."""
        client = get_client(self.app.api_url)
        detail = self.query_one("#risk-detail", RiskDetail)

        try:
            risk_id = int(event.row_key.value)
            risk = client.get_risk(risk_id)
            detail.show_risk(risk)
        except Exception as e:
            self.notify(f"Error loading risk: {e}", severity="error")
