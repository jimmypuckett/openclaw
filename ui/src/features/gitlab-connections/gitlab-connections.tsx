import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js";
import {
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { GitLabConnectionsState } from "./gitlab-connections-state.ts";

/** Personal GitLab identity for repository publishing. */
export function GitLabConnections(
  props: {
    connectRequest?: number;
    onAvailable?: (available: boolean) => void;
  } = {},
) {
  const context = useApplication();
  const state = new GitLabConnectionsState();
  const projection = projectOwner(state, (owner) => owner.view);
  const view = createMemo(() => projection.read());
  const [callbackUrl, setCallbackUrl] = createSignal("");
  let callbackInput: HTMLInputElement | undefined;

  const clearCallback = () => {
    setCallbackUrl("");
    if (callbackInput) {
      callbackInput.value = "";
    }
  };
  createEffect(
    () => view().eligible && view().status?.configured === true,
    (available) => {
      props.onAvailable?.(available);
    },
  );
  createEffect(
    () => ({ request: props.connectRequest ?? 0, configured: view().status?.configured }),
    ({ request, configured }, previous) => {
      if (request > 0 && request !== previous?.request && configured) {
        clearCallback();
        void state.start();
      }
    },
  );
  onSettled(() => {
    const sync = (snapshot: typeof context.gateway.snapshot) => {
      if (state.sync(snapshot)) {
        clearCallback();
      }
    };
    const unsubscribe = context.gateway.subscribe(sync);
    sync(context.gateway.snapshot);
    return () => {
      unsubscribe();
      clearCallback();
      state.dispose();
    };
  });

  const complete = (event: SubmitEvent) => {
    event.preventDefault();
    const value = callbackUrl();
    clearCallback();
    void state.complete(value);
  };

  return (
    <Show when={view().eligible && (view().status?.configured || view().error)}>
      <div data-gitlab-connections="personal">
        <SettingsSection
          title="Personal GitLab"
          description="Connect your own GitLab account for repository publishing."
          actions={
            <Show when={view().status?.configured}>
              <button
                type="button"
                class="btn btn--sm"
                disabled={view().busy}
                onClick={() => {
                  clearCallback();
                  void state.loadStatus();
                }}
              >
                Refresh
              </button>
            </Show>
          }
        >
          <Show when={view().error}>
            <SettingsRow
              title="GitLab connection"
              description={view().error}
              role="alert"
              control={
                <button
                  type="button"
                  class="btn btn--sm"
                  disabled={view().busy}
                  onClick={() => void state.loadStatus()}
                >
                  Retry
                </button>
              }
            />
          </Show>
          <Show when={view().status?.configured}>
            <SettingsRow
              title="Current publisher"
              description={
                view().status?.connected && view().status?.account
                  ? `GitLab publications use @${view().status!.account!.login}.`
                  : view().status?.reconnectRequired
                    ? "Reconnect your GitLab account before publishing."
                    : "No personal GitLab account connected."
              }
              control={
                <SettingsStatus
                  kind={
                    view().status?.connected
                      ? "ok"
                      : view().status?.reconnectRequired
                        ? "warn"
                        : "muted"
                  }
                  label={
                    view().status?.connected
                      ? "Connected"
                      : view().status?.reconnectRequired
                        ? "Reconnect required"
                        : "Disconnected"
                  }
                />
              }
            />
            <Show when={view().status?.connected && view().status?.account}>
              <SettingsRow
                title="Verified GitLab account"
                description={`${view().status!.account!.name} · ${view().status!.account!.issuer}`}
                control={<SettingsValue value={`@${view().status!.account!.login}`} />}
              />
            </Show>
            <SettingsRow
              title="Authorization"
              description="Sign in through GitLab, then paste the full final redirect URL below."
              control={
                <button
                  type="button"
                  class="btn btn--sm"
                  disabled={view().busy}
                  onClick={() => {
                    clearCallback();
                    void state.start();
                  }}
                >
                  {view().status?.connected ? "Reconnect GitLab" : "Connect GitLab"}
                </button>
              }
            />
            <Show when={view().pending}>
              <SettingsRow
                title="Continue in GitLab"
                description="Open GitLab in a new tab and approve access for your account."
                control={
                  <a
                    class="btn btn--sm"
                    href={view().pending!.authorizationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open GitLab sign-in
                  </a>
                }
              />
              <SettingsRow
                title="Finish connection"
                description="Paste the complete URL from your browser after GitLab redirects you. It is cleared from this field when submitted."
                stacked
                control={
                  <form onSubmit={complete}>
                    <input
                      ref={(element) => (callbackInput = element)}
                      class="settings-input"
                      type="password"
                      autocomplete="off"
                      spellcheck="false"
                      aria-label="Final GitLab redirect URL"
                      value={callbackUrl()}
                      onInput={(event) => setCallbackUrl(event.currentTarget.value)}
                    />
                    <button
                      type="submit"
                      class="btn btn--sm"
                      disabled={view().busy || !callbackUrl().trim()}
                    >
                      Finish GitLab connection
                    </button>
                  </form>
                }
              />
            </Show>
            <Show when={view().status?.connected || view().pending}>
              <SettingsRow
                title="Disconnect personal GitLab"
                description="Removes this profile’s selected GitLab account."
                control={
                  <button
                    type="button"
                    class="btn btn--sm"
                    disabled={view().busy}
                    onClick={() => {
                      clearCallback();
                      void state.disconnect();
                    }}
                  >
                    Disconnect
                  </button>
                }
              />
            </Show>
          </Show>
        </SettingsSection>
      </div>
    </Show>
  );
}
