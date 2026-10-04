import { StatusBar } from 'expo-status-bar';
import { Image, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { HoldPressable } from './src/components/HoldPressable';
import { initialsFor } from './src/format';
import { AccountScreen } from './src/screens/AccountScreen';
import { BagScreen } from './src/screens/BagScreen';
import { CourseBuilderScreen } from './src/screens/CourseBuilderScreen';
import { FindCoursesScreen } from './src/screens/FindCoursesScreen';
import { HoleWizardScreen } from './src/screens/HoleWizardScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { NewCourseScreen } from './src/screens/NewCourseScreen';
import { PracticeScreen } from './src/screens/PracticeScreen';
import { RoundDetailScreen } from './src/screens/RoundDetailScreen';
import { RoundScreen } from './src/screens/RoundScreen';
import { RoundsScreen } from './src/screens/RoundsScreen';
import { StatsScreen } from './src/screens/StatsScreen';
import { AppProvider, useApp, type Screen } from './src/state/AppState';
import { styles } from './src/theme';

const SCREENS: Record<Screen, () => React.JSX.Element> = {
  Home: HomeScreen,
  CourseBuilder: CourseBuilderScreen,
  NewCourse: NewCourseScreen,
  HoleWizard: HoleWizardScreen,
  BagBuilder: BagScreen,
  Practice: PracticeScreen,
  Round: RoundScreen,
  Account: AccountScreen,
  FindCourses: FindCoursesScreen,
  Rounds: RoundsScreen,
  RoundDetail: RoundDetailScreen,
  Insights: StatsScreen,
};

// The brand bar and account button above every screen, and the status bar below the round and stats.
const Shell = () => {
  const { screen, navigate, account, shots } = useApp();
  const { width } = useWindowDimensions();
  // During a round, these buttons need a hold like every other round button.
  const Button = screen === 'Round' ? HoldPressable : Pressable;
  const CurrentScreen = SCREENS[screen];
  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={[styles.appFrame, width < 390 && styles.appFrameCompact]}>
        <View style={styles.topline}>
          <Button onPress={() => navigate('Home')} style={styles.brand} accessibilityRole="button" accessibilityLabel="Glide Path home">
            <Image source={require('./assets/logo-mark.png')} style={styles.brandLogo} accessibilityIgnoresInvertColors />
            <View style={styles.brandCopy}>
              <Text style={styles.brandName}>GLIDE PATH</Text>
              <Text style={styles.brandSub}>FIELD LOG · EST. 2025</Text>
            </View>
          </Button>
          <Button onPress={() => navigate('Account')} style={[styles.avatar, account && styles.avatarSignedIn]} accessibilityRole="button" accessibilityLabel={account ? `Account: ${account.user.displayName}` : 'Sign in'}>
            <Text style={[styles.avatarText, account && styles.avatarTextSignedIn]}>{account ? initialsFor(account.user.displayName) : '?'}</Text>
          </Button>
        </View>
        <CurrentScreen />
        {screen === 'Round' || screen === 'Insights' ? <View style={styles.bottomBar}><Text style={styles.bottomStatus}><View style={styles.statusDot} /> SESSION SAVED LOCALLY</Text><Text style={styles.bottomCount}>{shots.length} THROWS</Text></View> : null}
      </View>
    </View>
  );
};

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
