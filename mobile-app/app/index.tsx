import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import { fetchHealthData, type HealthPayload } from '../services/health';
import {
  GOOGLE_WEB_CLIENT_ID,
  GOOGLE_IOS_CLIENT_ID,
  googleAuthReady,
} from '../constants/googleAuth';

const GOFIT_URL = 'https://waqasali-dev1.github.io/GoFit';

type GoogleSigninModule = typeof import('@react-native-google-signin/google-signin');

function loadGoogleSignin(): GoogleSigninModule | null {
  if (Platform.OS === 'web') return null;
  try {
    // Lazy require so the web bundle never touches the native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@react-native-google-signin/google-signin');
  } catch {
    return null;
  }
}

let googleSigninConfigured = false;
function ensureGoogleSignin(): GoogleSigninModule | null {
  const mod = loadGoogleSignin();
  if (!mod || googleSigninConfigured) return mod;
  googleSigninConfigured = true;
  mod.GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    ...(Platform.OS === 'ios' && GOOGLE_IOS_CLIENT_ID
      ? { iosClientId: GOOGLE_IOS_CLIENT_ID }
      : {}),
  });
  return mod;
}

export default function App() {
  const webViewRef = useRef<any>(null);
  const [pageReady, setPageReady] = useState(false);
  const [healthData, setHealthData] = useState<HealthPayload | null>(null);

  const lastHealthFetch = useRef(0);

  const syncHealth = useCallback(async (force = false) => {
    if (!force && Date.now() - lastHealthFetch.current < 60000) return;
    lastHealthFetch.current = Date.now();
    try {
      const data = await fetchHealthData();
      console.log(
        '[gofit-health] fetched:',
        data
          ? `steps=${Object.keys(data.steps).length}d weight=${!!data.weight} workouts=${data.workouts.length}`
          : 'null',
      );
      setHealthData(data);
    } catch (e) {
      console.log('[gofit-health] fetch failed:', e);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot fetch on mount; setState happens after the async health read
    syncHealth(true);
  }, [syncHealth]);

  useEffect(() => {
    if (pageReady && healthData) {
      const hasData =
        Object.keys(healthData.steps).length > 0 ||
        healthData.weight ||
        healthData.workouts.length > 0;
      if (hasData) {
        // Stash the payload and call __gofitHealth if it exists; the page
        // flushes __gofitPendingHealth itself once its boot script finishes,
        // so a slow CDN/module load can't drop the data.
        webViewRef.current?.injectJavaScript(
          `window.__gofitPendingHealth=${JSON.stringify(healthData)};if(window.__gofitHealth)window.__gofitHealth(window.__gofitPendingHealth);true;`,
        );
      }
    }
  }, [healthData, pageReady]);

  const replyToWeb = (payload: Record<string, unknown>) => {
    webViewRef.current?.injectJavaScript(
      `window.__gofitNativeGoogle&&window.__gofitNativeGoogle(${JSON.stringify(payload)});true;`,
    );
  };

  const handleGoogleSignIn = async () => {
    const mod = ensureGoogleSignin();
    if (!mod || !googleAuthReady(Platform.OS)) {
      replyToWeb({ error: 'native-google-not-configured' });
      return;
    }
    try {
      if (Platform.OS === 'android') {
        await mod.GoogleSignin.hasPlayServices({
          showPlayServicesUpdateDialog: true,
        });
      }
      const res = await mod.GoogleSignin.signIn();
      if (res.type === 'cancelled') {
        replyToWeb({ error: 'cancelled' });
        return;
      }
      const idToken = res.data?.idToken;
      if (!idToken) {
        replyToWeb({ error: 'missing-id-token' });
        return;
      }
      replyToWeb({ idToken });
    } catch (err: any) {
      const code = err?.code;
      replyToWeb({
        error:
          code === mod.statusCodes.SIGN_IN_CANCELLED ||
          code === 'SIGN_IN_CANCELLED'
            ? 'cancelled'
            : err?.message || 'google-sign-in-failed',
      });
    }
  };

  const onMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg && msg.type === 'gofit:google-signin') {
        handleGoogleSignIn();
      } else if (msg && msg.type === 'gofit:health-request') {
        syncHealth();
      }
    } catch {
      // ignore non-JSON messages
    }
  };

  return (
    <>
      <StatusBar style={Platform.OS === 'ios' ? 'dark' : 'auto'} />
      <WebView
        ref={webViewRef}
        source={{ uri: GOFIT_URL }}
        style={{ flex: 1 }}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        applicationNameForUserAgent="GoFitApp"
        pullToRefreshEnabled
        startInLoadingState
        onMessage={onMessage}
        injectedJavaScriptBeforeContentLoaded={`
          window.__GOFIT_APP__=1;
          document.documentElement.classList.add('gofit-app');
          (function(){
            var apply=function(){
              var m=document.querySelector('meta[name="viewport"]');
              if(!m){m=document.createElement('meta');m.name='viewport';document.head.appendChild(m)}
              m.setAttribute('content','width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
            };
            if(document.head)apply();else document.addEventListener('DOMContentLoaded',apply);
            document.addEventListener('gesturestart',function(e){e.preventDefault()});
            document.addEventListener('gesturechange',function(e){e.preventDefault()});
          })();
          true;
        `}
        onLoadEnd={() => {
          setPageReady(true);
        }}
        onShouldStartLoadWithRequest={() => true}
      />
    </>
  );
}
