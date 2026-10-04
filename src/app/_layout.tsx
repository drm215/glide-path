import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Image, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { HoldPressable } from '../components/HoldPressable';
import { initialsFor } from '../format';
import { backTo, go, PATHS } from '../navigation';
import { AppProvider, useApp } from '../state/AppState';
import { PAPER, styles } from '../theme';

// The brand bar and account button above every screen, and the status bar below the round and stats.
const Shell = () => {
  const { account, shots } = useApp();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const onRound = pathname === PATHS.Round;
  // During a round, these buttons need a hold like every other round button.
  const Button = onRound ? HoldPressable : Pressable;
  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={[styles.appFrame, width < 390 && styles.appFrameCompact]}>
        <View style={styles.topline}>
          <Button onPress={() => backTo('Home')} style={styles.brand} accessibilityRole="button" accessibilityLabel="Glide Path home">
            <Image source={require('../../assets/logo-mark.png')} style={styles.brandLogo} accessibilityIgnoresInvertColors />
            <View style={styles.brandCopy}>
              <Text style={styles.brandName}>GLIDE PATH</Text>
              <Text style={styles.brandSub}>FIELD LOG · EST. 2025</Text>
            </View>
          </Button>
          <Button onPress={() => { if (pathname !== PATHS.Account) go('Account'); }} style={[styles.avatar, account && styles.avatarSignedIn]} accessibilityRole="button" accessibilityLabel={account ? `Account: ${account.user.displayName}` : 'Sign in'}>
            <Text style={[styles.avatarText, account && styles.avatarTextSignedIn]}>{account ? initialsFor(account.user.displayName) : '?'}</Text>
          </Button>
        </View>
        <View style={styles.stack}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: PAPER } }}>
            {/* A stray swipe mustn't leave a round; its buttons need a hold for the same reason. */}
            <Stack.Screen name="round" options={{ gestureEnabled: false }} />
          </Stack>
        </View>
        {onRound || pathname === PATHS.Insights ? <View style={styles.bottomBar}><Text style={styles.bottomStatus}><View style={styles.statusDot} /> SESSION SAVED LOCALLY</Text><Text style={styles.bottomCount}>{shots.length} THROWS</Text></View> : null}
      </View>
    </View>
  );
};

export default function RootLayout() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
