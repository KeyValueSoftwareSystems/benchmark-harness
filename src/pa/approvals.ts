/** Things the simulated user can approve before the assistant does them. */
export const ApprovalAction = {
	sendMessage: "send_message",
	deleteCalendarEvent: "delete_calendar_event",
	createCalendarEvent: "create_calendar_event",
	createTodoTask: "create_todo_task",
	submitFinanceReport: "submit_finance_report",
	createSchedulerJob: "create_scheduler_job",
	deleteSchedulerJob: "delete_scheduler_job",
} as const;
export type ApprovalAction = (typeof ApprovalAction)[keyof typeof ApprovalAction];

interface ApprovalActionInfo {
	/** How the action reads in the persona's prompt and in the approval message. */
	label: string;
	/** The mock-service tools the approval covers. */
	tools: string[];
}

export const APPROVAL_ACTIONS: Record<ApprovalAction, ApprovalActionInfo> = {
	[ApprovalAction.sendMessage]: { label: "send an email or message", tools: ["gmail_send_message", "workmail_send_message", "contacts_send_message"] },
	[ApprovalAction.deleteCalendarEvent]: { label: "delete a calendar event", tools: ["calendar_delete_event"] },
	[ApprovalAction.createCalendarEvent]: { label: "create a calendar event", tools: ["calendar_create_event"] },
	[ApprovalAction.createTodoTask]: { label: "create a to-do task", tools: ["todo_create_task"] },
	[ApprovalAction.submitFinanceReport]: { label: "submit a finance report", tools: ["finance_report_submit"] },
	[ApprovalAction.createSchedulerJob]: { label: "create a scheduled job", tools: ["scheduler_create_job"] },
	[ApprovalAction.deleteSchedulerJob]: { label: "delete a scheduled job", tools: ["scheduler_delete_job"] },
};

export const isApprovalAction = (value: unknown): value is ApprovalAction => typeof value === "string" && Object.hasOwn(APPROVAL_ACTIONS, value);

export function actionForTool(tool: string): ApprovalAction | undefined {
	return (Object.keys(APPROVAL_ACTIONS) as ApprovalAction[]).find((action) => APPROVAL_ACTIONS[action].tools.includes(tool));
}

/** An action the simulated user may approve in one world, as the persona and the extension see it. */
export interface ApprovableAction {
	action: ApprovalAction;
	label: string;
}
