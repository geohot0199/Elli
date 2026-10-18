import { Trans } from "@lingui/react/macro";
import {
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Toggle,
} from "@rakazo/ui-web";
import { useId, useState } from "react";
import type { FalkorDBFieldError } from "./falkordb-settings";
import { FALKORDB_URL_PLACEHOLDER, falkordbConnectionDraft } from "./falkordb-settings";
import type { MemoryProviderSettingsFormProps } from "./registry";

export function FalkorDBSettingsForm({ busy, onConnect }: MemoryProviderSettingsFormProps) {
  const urlId = useId();
  const urlErrorId = useId();
  const usernameId = useId();
  const passwordId = useId();
  const passwordErrorId = useId();
  const namespaceId = useId();
  const hopsId = useId();
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<FalkorDBFieldError | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<FalkorDBFieldError | null>(null);
  const [namespace, setNamespace] = useState("rakazo");
  const [maxHops, setMaxHops] = useState(2);
  const [allowWrites, setAllowWrites] = useState(true);

  async function connect() {
    const result = falkordbConnectionDraft({
      url,
      username,
      password,
      namespace,
      maxHops,
      allowWrites,
    });
    if (!result.ok) {
      if (result.error === "password-required") {
        setPasswordError(result.error);
        return;
      }
      setUrlError(result.error);
      return;
    }
    setUrlError(null);
    setPasswordError(null);
    if (await onConnect(result.draft)) setPassword("");
  }

  return (
    <>
      <Field className="mt-1" data-invalid={urlError ? true : undefined}>
        <FieldLabel htmlFor={urlId}>
          <Trans>FalkorDB endpoint</Trans>
        </FieldLabel>
        <Input
          id={urlId}
          value={url}
          required
          disabled={busy}
          aria-invalid={urlError ? true : undefined}
          aria-describedby={urlError ? urlErrorId : undefined}
          onChange={(event) => {
            setUrl(event.target.value);
            setUrlError(null);
          }}
          placeholder={FALKORDB_URL_PLACEHOLDER}
          autoComplete="off"
          spellCheck={false}
        />
        {urlError === "url-required" ? (
          <FieldError id={urlErrorId}>
            <Trans>FalkorDB endpoint is required.</Trans>
          </FieldError>
        ) : null}
        <p className="mt-1 text-[12.5px] text-muted-foreground/70">
          <Trans>Use falkordb://host:6379. Private LAN endpoints need the deployment owner.</Trans>
        </p>
      </Field>

      <div className="mt-4 flex gap-3">
        <Field className="flex-1">
          <FieldLabel htmlFor={usernameId}>
            <Trans>Username (optional)</Trans>
          </FieldLabel>
          <Input
            id={usernameId}
            value={username}
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field className="flex-1" data-invalid={passwordError ? true : undefined}>
          <FieldLabel htmlFor={passwordId}>
            <Trans>Password (optional)</Trans>
          </FieldLabel>
          <Input
            id={passwordId}
            value={password}
            disabled={busy}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? passwordErrorId : undefined}
            onChange={(event) => {
              setPassword(event.target.value);
              setPasswordError(null);
            }}
            type="password"
            autoComplete="new-password"
          />
          {passwordError === "password-required" ? (
            <FieldError id={passwordErrorId}>
              <Trans>Enter the password for this username.</Trans>
            </FieldError>
          ) : null}
        </Field>
      </div>

      <div className="mt-4 flex gap-3">
        <Field className="flex-1">
          <FieldLabel htmlFor={namespaceId}>
            <Trans>Graph namespace</Trans>
          </FieldLabel>
          <Input
            id={namespaceId}
            value={namespace}
            disabled={busy}
            onChange={(event) => setNamespace(event.target.value)}
            placeholder="rakazo"
            autoComplete="off"
          />
        </Field>
        <Field className="w-32">
          <FieldLabel htmlFor={hopsId}>
            <Trans>Recall hops</Trans>
          </FieldLabel>
          <NativeSelect
            id={hopsId}
            className="w-full"
            value={String(maxHops)}
            disabled={busy}
            onChange={(event) => setMaxHops(Number(event.target.value))}
          >
            {[1, 2, 3].map((hops) => (
              <NativeSelectOption key={hops} value={String(hops)}>
                {hops}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <div className="mt-4 text-[13.5px] text-muted-foreground">
        <Trans>Allow writing</Trans>
        <div className="mt-2 flex gap-2">
          <Toggle
            variant="outline"
            pressed={!allowWrites}
            disabled={busy}
            onPressedChange={() => setAllowWrites(false)}
            className="flex-1 font-normal text-muted-foreground aria-pressed:text-foreground"
          >
            <Trans>Recall only</Trans>
          </Toggle>
          <Toggle
            variant="outline"
            pressed={allowWrites}
            disabled={busy}
            onPressedChange={() => setAllowWrites(true)}
            className="flex-1 font-normal text-muted-foreground aria-pressed:text-foreground"
          >
            <Trans>Recall and write</Trans>
          </Toggle>
        </div>
      </div>

      <Button
        type="button"
        variant="secondary"
        className="mt-5 rounded-full"
        size="sm"
        disabled={busy || !url.trim()}
        onClick={() => void connect()}
      >
        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </>
  );
}
