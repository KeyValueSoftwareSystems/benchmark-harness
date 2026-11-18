import type { JobStatus } from "../../shared/types.ts";

/** An agent may fetch its model (and key) only while its own job is starting or running. */
export const canRegister = (status: JobStatus): boolean => status === "provisioning" || status === "running";
