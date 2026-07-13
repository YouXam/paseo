import { useCallback, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { Text, View } from "react-native";
import { Cloud, Download, LogOut, Upload } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SettingsSection } from "@/screens/settings/settings-section";
import { getCloudSyncManager, getDefaultCloudSyncEndpoint } from "@/sync/manager";
import { useCloudSyncState } from "@/sync/provider";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedCloud = withUnistyles(Cloud);
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const CLOUD_SYNC_STATUS_LABEL_KEYS: Record<ReturnType<typeof useCloudSyncState>["status"], string> =
  {
    disabled: "settings.general.cloudSync.status.disabled",
    signed_out: "settings.general.cloudSync.status.signedOut",
    authenticating: "settings.general.cloudSync.status.authenticating",
    syncing: "settings.general.cloudSync.status.syncing",
    synced: "settings.general.cloudSync.status.synced",
    error: "settings.general.cloudSync.status.error",
  };

function formatSyncTime(value: number | null, locale: string): string | null {
  if (!value) {
    return null;
  }
  return new Date(value).toLocaleString(locale);
}

const CLOUD_SYNC_BASE_KEY = "settings.general.cloudSync";

const CLOUD_SYNC_ERROR_MESSAGE_KEYS: Record<string, string> = {
  "Sign in before syncing.": `${CLOUD_SYNC_BASE_KEY}.errors.signInRequired`,
  "Sync endpoint is required.": `${CLOUD_SYNC_BASE_KEY}.errors.endpointRequired`,
  "Username is required.": `${CLOUD_SYNC_BASE_KEY}.errors.usernameRequired`,
  "Password is required.": `${CLOUD_SYNC_BASE_KEY}.errors.passwordRequired`,
  "Cloud sync requires Web Crypto support in this runtime.": `${CLOUD_SYNC_BASE_KEY}.errors.webCryptoRequired`,
  "Unsupported encrypted sync snapshot.": `${CLOUD_SYNC_BASE_KEY}.errors.unsupportedSnapshot`,
  "Invalid cloud sync snapshot.": `${CLOUD_SYNC_BASE_KEY}.errors.invalidSnapshot`,
  "Revision conflict": `${CLOUD_SYNC_BASE_KEY}.errors.revisionConflict`,
  "Missing bearer token": `${CLOUD_SYNC_BASE_KEY}.errors.missingBearerToken`,
  "Invalid bearer token": `${CLOUD_SYNC_BASE_KEY}.errors.invalidBearerToken`,
  "User not found": `${CLOUD_SYNC_BASE_KEY}.errors.userNotFound`,
  "Invalid JSON body": `${CLOUD_SYNC_BASE_KEY}.errors.invalidJsonBody`,
  "Invalid username": `${CLOUD_SYNC_BASE_KEY}.errors.invalidUsername`,
  "User already exists": `${CLOUD_SYNC_BASE_KEY}.errors.userAlreadyExists`,
  "Invalid username or password": `${CLOUD_SYNC_BASE_KEY}.errors.invalidCredentials`,
  "Invalid base revision": `${CLOUD_SYNC_BASE_KEY}.errors.invalidBaseRevision`,
  "Not found": `${CLOUD_SYNC_BASE_KEY}.errors.notFound`,
  "Internal server error": `${CLOUD_SYNC_BASE_KEY}.errors.internalServerError`,
};

function translateCloudSyncError(message: string, t: TFunction): string {
  const key = CLOUD_SYNC_ERROR_MESSAGE_KEYS[message];
  if (key) {
    return t(key);
  }
  const requestFailedMatch = message.match(/^Sync request failed \((\d+)\)$/);
  if (requestFailedMatch) {
    return t(`${CLOUD_SYNC_BASE_KEY}.errors.requestFailed`, {
      status: requestFailedMatch[1],
    });
  }
  return message;
}

export function CloudSyncSection() {
  const { i18n, t } = useTranslation();
  const state = useCloudSyncState();
  const manager = getCloudSyncManager();
  const endpointSeed = state.endpoint || getDefaultCloudSyncEndpoint();
  const usernameSeed = state.savedUsername ?? "";
  const [endpoint, setEndpoint] = useState(endpointSeed);
  const [username, setUsername] = useState(usernameSeed);
  const [password, setPassword] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const isBusy =
    state.status === "authenticating" || state.status === "syncing" || pendingAction !== null;
  const isSignedIn = state.hasSession;

  useEffect(() => {
    setEndpoint(endpointSeed);
  }, [endpointSeed]);

  useEffect(() => {
    setUsername(usernameSeed);
  }, [usernameSeed]);

  const authInput = useMemo(
    () => ({
      endpoint,
      username,
      password,
    }),
    [endpoint, password, username],
  );

  const runAction = useCallback(async (name: string, action: () => Promise<void> | void) => {
    setPendingAction(name);
    try {
      await action();
    } catch (error) {
      console.warn("[CloudSync] Action failed", { name, error });
    } finally {
      setPendingAction(null);
    }
  }, []);

  const handleRegister = useCallback(() => {
    void runAction("register", () => manager.register(authInput));
  }, [authInput, manager, runAction]);

  const handleLogin = useCallback(() => {
    void runAction("login", () => manager.login(authInput));
  }, [authInput, manager, runAction]);

  const handlePush = useCallback(() => {
    void runAction("push", () => manager.syncNow());
  }, [manager, runAction]);

  const handlePull = useCallback(() => {
    void runAction("pull", () => manager.pullNow());
  }, [manager, runAction]);

  const handleLogout = useCallback(() => {
    manager.logout();
    setPassword("");
  }, [manager]);

  const handleEndpointBlur = useCallback(() => {
    void manager.setEndpoint(endpoint);
  }, [endpoint, manager]);

  const lastSyncLabel =
    formatSyncTime(state.lastSyncAt, i18n.language) ?? t(`${CLOUD_SYNC_BASE_KEY}.lastSyncNever`);
  const errorDescription = state.lastError ? translateCloudSyncError(state.lastError, t) : null;

  return (
    <SettingsSection title={t(`${CLOUD_SYNC_BASE_KEY}.title`)}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t(`${CLOUD_SYNC_BASE_KEY}.rowTitle`)}</Text>
            <Text style={settingsStyles.rowHint}>{t(`${CLOUD_SYNC_BASE_KEY}.rowHint`)}</Text>
          </View>
          <ThemedCloud size={ICON_SIZE.md} uniProps={mutedIconColor} />
        </View>
        <View style={FORM_ROW_STYLE}>
          <Field
            label={t(`${CLOUD_SYNC_BASE_KEY}.endpoint.label`)}
            hint={t(`${CLOUD_SYNC_BASE_KEY}.endpoint.hint`)}
            testID="cloud-sync-endpoint"
          >
            <FormTextInput
              initialValue={endpointSeed}
              resetKey={`endpoint:${endpointSeed}`}
              value={endpoint}
              onChangeText={setEndpoint}
              onBlur={handleEndpointBlur}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSignedIn && !isBusy}
              placeholder={t(`${CLOUD_SYNC_BASE_KEY}.endpoint.placeholder`)}
            />
          </Field>
          <Field label={t(`${CLOUD_SYNC_BASE_KEY}.username.label`)} testID="cloud-sync-username">
            <FormTextInput
              initialValue={usernameSeed}
              resetKey={`username:${usernameSeed}`}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSignedIn && !isBusy}
              placeholder={t(`${CLOUD_SYNC_BASE_KEY}.username.placeholder`)}
            />
          </Field>
          {!isSignedIn ? (
            <Field label={t(`${CLOUD_SYNC_BASE_KEY}.password.label`)} testID="cloud-sync-password">
              <FormTextInput
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                editable={!isBusy}
                placeholder={t(`${CLOUD_SYNC_BASE_KEY}.password.placeholder`)}
              />
            </Field>
          ) : null}
        </View>
        <View style={STATUS_ROW_STYLE}>
          <View style={STATUS_CONTENT_STYLE}>
            <Text style={settingsStyles.rowTitle}>
              {t(CLOUD_SYNC_STATUS_LABEL_KEYS[state.status])}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {isSignedIn
                ? t(`${CLOUD_SYNC_BASE_KEY}.signedInDetails`, {
                    username: state.sessionUsername,
                    revision: state.remoteRevision,
                    lastSync: lastSyncLabel,
                  })
                : t(`${CLOUD_SYNC_BASE_KEY}.signedOutHint`)}
            </Text>
          </View>
          {isSignedIn ? (
            <View style={styles.actions}>
              <Button
                variant="outline"
                size="sm"
                leftIcon={Upload}
                onPress={handlePush}
                disabled={isBusy}
                loading={pendingAction === "push"}
              >
                {t(`${CLOUD_SYNC_BASE_KEY}.actions.push`)}
              </Button>
              <Button
                variant="outline"
                size="sm"
                leftIcon={Download}
                onPress={handlePull}
                disabled={isBusy}
                loading={pendingAction === "pull"}
              >
                {t(`${CLOUD_SYNC_BASE_KEY}.actions.pull`)}
              </Button>
              <Button variant="ghost" size="sm" leftIcon={LogOut} onPress={handleLogout}>
                {t(`${CLOUD_SYNC_BASE_KEY}.actions.signOut`)}
              </Button>
            </View>
          ) : (
            <View style={styles.actions}>
              <Button
                variant="outline"
                size="sm"
                onPress={handleLogin}
                disabled={isBusy}
                loading={pendingAction === "login"}
              >
                {t(`${CLOUD_SYNC_BASE_KEY}.actions.signIn`)}
              </Button>
              <Button
                variant="default"
                size="sm"
                onPress={handleRegister}
                disabled={isBusy}
                loading={pendingAction === "register"}
              >
                {t(`${CLOUD_SYNC_BASE_KEY}.actions.register`)}
              </Button>
            </View>
          )}
        </View>
      </View>
      {errorDescription ? (
        <View style={styles.alert}>
          <Alert
            variant="error"
            title={t(`${CLOUD_SYNC_BASE_KEY}.errorTitle`)}
            description={errorDescription}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  formRow: {
    alignItems: "stretch",
    flexDirection: "column",
    gap: theme.spacing[3],
  },
  actions: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  statusRow: {
    alignItems: "stretch",
    flexDirection: "column",
    gap: theme.spacing[3],
  },
  statusContent: {
    marginRight: 0,
  },
  alert: {
    marginTop: theme.spacing[3],
  },
}));

const FORM_ROW_STYLE = [settingsStyles.row, settingsStyles.rowBorder, styles.formRow];
const STATUS_ROW_STYLE = [settingsStyles.row, settingsStyles.rowBorder, styles.statusRow];
const STATUS_CONTENT_STYLE = [settingsStyles.rowContent, styles.statusContent];
