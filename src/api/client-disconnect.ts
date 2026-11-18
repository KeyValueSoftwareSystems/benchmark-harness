const PREMATURE_CLOSE_CODE = "ERR_STREAM_PREMATURE_CLOSE";
const UNABLE_TO_PIPE_CODE = "ERR_STREAM_UNABLE_TO_PIPE";

export interface ProxyStreamState {
	/** The provider's reply had finished streaming. */
	replyStreamEnded: boolean;
	/** The caller's connection was already closed or destroyed. */
	clientConnectionClosed: boolean;
}

/**
 * True when a proxy stream error only means the caller went away: it hung up after the whole reply was sent
 * (premature close), or before the reply could be written to it (unable to pipe). Not a provider failure.
 */
export function isClientDisconnect(err: { code?: string }, state: ProxyStreamState): boolean {
	if (err.code === PREMATURE_CLOSE_CODE) return state.replyStreamEnded;
	return err.code === UNABLE_TO_PIPE_CODE && state.clientConnectionClosed;
}
