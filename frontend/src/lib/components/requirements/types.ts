// The wire types come from the contracts; these are the short names the screens use.
import type {
	RequirementAllocation,
	RequirementCheck,
	RequirementDossier,
	RequirementEventDetail,
	RequirementEventItem,
	RequirementEventSummary,
	RequirementFinding,
	RequirementQueueItem,
	RequirementRedline,
	RequirementRef,
	RequirementSegment,
	RequirementSummary,
	RequirementTree,
	RequirementTreeItem,
	RequirementVerificationStatus
} from '@opal/shared';

export type Finding = RequirementFinding;
export type Verification = RequirementVerificationStatus;
export type TreeItem = RequirementTreeItem;
export type TreeResponse = RequirementTree;
export type Ref = RequirementRef;
export type Summary = RequirementSummary;
export type Check = RequirementCheck;
export type Allocation = RequirementAllocation;
export type Dossier = RequirementDossier;
export type Segment = RequirementSegment;
export type RedlineData = RequirementRedline;
export type QueueItem = RequirementQueueItem;
export type EventSummary = RequirementEventSummary;
export type EventItem = RequirementEventItem;
export type EventDetail = RequirementEventDetail;
