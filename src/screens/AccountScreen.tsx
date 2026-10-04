import { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { API_URL, deleteAccount as deleteAccountRequest, register as registerRequest, requestPasswordReset, resetPassword, signIn as signInRequest } from '../../lib/api';
import { styles } from '../theme';
import { errorMessage, formatSyncTime } from '../format';
import { ScreenHeading } from '../components/ScreenHeading';
import { useApp } from '../state/AppState';

export const AccountScreen = () => {
  const { account, finishSignIn, pendingChanges, runSync, setCourses, setHistory, setSyncError, signOutLocally, syncError, syncing } = useApp();
  // 'forgot' asks for the email to send a reset code to; 'reset' takes the code and a new password.
  const [authMode, setAuthMode] = useState<'signIn' | 'register' | 'forgot' | 'reset'>('signIn');
  const [resetCode, setResetCode] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  const switchAuthMode = (next: typeof authMode) => {
    setAuthMode(next);
    setAuthError('');
    setAuthNotice('');
  };

  const sendResetCode = async () => {
    const email = authEmail.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setAuthError('Enter the email address for your account.');
      return;
    }
    setAuthBusy(true);
    setAuthError('');
    try {
      await requestPasswordReset(email);
      setResetCode('');
      setAuthPassword('');
      setAuthMode('reset');
      setAuthNotice(`If ${email} has an account, a 6-digit code is on its way. It expires in 15 minutes; check your spam folder if it doesn’t arrive.`);
    } catch (error) {
      setAuthError(errorMessage(error, 'Could not send a reset code.'));
    } finally {
      setAuthBusy(false);
    }
  };


  const submitPasswordReset = async () => {
    const email = authEmail.trim();
    const code = resetCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setAuthError('Enter the 6-digit code from the email.');
      return;
    }
    if (authPassword.length < 8) {
      setAuthError('Use a new password of at least 8 characters.');
      return;
    }
    setAuthBusy(true);
    setAuthError('');
    try {
      const result = await resetPassword(email, code, authPassword);
      if (!(await finishSignIn(result))) return;
      setAuthPassword('');
      setResetCode('');
      setAuthNotice('');
      setAuthMode('signIn');
      setSyncError('');
    } catch (error) {
      setAuthError(errorMessage(error, 'Could not reset the password.'));
    } finally {
      setAuthBusy(false);
    }
  };

  const submitAuth = async () => {
    if (authMode === 'forgot') return sendResetCode();
    if (authMode === 'reset') return submitPasswordReset();
    const email = authEmail.trim();
    const name = authName.trim();
    if (!email || !authPassword || (authMode === 'register' && !name)) {
      setAuthError('Fill in every field.');
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setAuthError('Enter a valid email address.');
      return;
    }
    if (authMode === 'register' && authPassword.length < 8) {
      setAuthError('Use a password of at least 8 characters.');
      return;
    }
    setAuthBusy(true);
    setAuthError('');
    try {
      const result = authMode === 'register' ? await registerRequest(email, authPassword, name) : await signInRequest(email, authPassword);
      if (!(await finishSignIn(result))) return;
      setAuthPassword('');
      setSyncError('');
    } catch (error) {
      setAuthError(errorMessage(error, 'Could not sign in.'));
    } finally {
      setAuthBusy(false);
    }
  };

  const confirmSignOut = () => {
    Alert.alert(
      'Sign out?',
      `Your courses, rounds and bag stay on this phone.${pendingChanges ? ` ${pendingChanges} unsynced ${pendingChanges === 1 ? 'change' : 'changes'} will upload when you sign in again.` : ''}`,
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', onPress: signOutLocally }],
    );
  };

  const confirmDeleteAccount = () => {
    if (!account) return;
    const token = account.token;
    Alert.alert(
      'Delete your account?',
      'This permanently deletes your Glide Path account and everything synced to it, including published courses and shared round links. Data on this phone is kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete account',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteAccountRequest(token);
              setCourses((current) => current.map((course) => ({ ...course, uid: undefined, published: false })));
              setHistory((current) => current.map((session) => ({ ...session, shared: false, shareToken: null })));
              signOutLocally();
            } catch (error) {
              Alert.alert('Could not delete account', errorMessage(error, 'Try again when you have a connection.'));
            }
          },
        },
      ],
    );
  };

  return <>
    <ScreenHeading eyebrow="SYNC & SHARING" title={account ? 'Your account.' : 'Sign in.'} />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {account ? <>
        <View style={styles.menuIntro}>
          <Text style={styles.menuIntroLabel}>SIGNED IN AS</Text>
          <Text style={styles.menuIntroTitle}>{account.user.displayName}</Text>
          <Text style={styles.menuIntroCopy}>{account.user.email}</Text>
        </View>
        <View style={styles.builderPanel}>
          <Text style={styles.builderLabel}>SYNC</Text>
          <Text style={styles.accountStatus}>{syncing ? 'Syncing…' : account.lastSyncedAt ? `Last synced ${formatSyncTime(account.lastSyncedAt)}` : 'Not synced yet'}</Text>
          <Text style={styles.courseItemMeta}>{pendingChanges ? `${pendingChanges} ${pendingChanges === 1 ? 'change' : 'changes'} waiting to upload` : 'Everything on this phone is backed up.'}</Text>
          {syncError ? <Text style={styles.authError}>{syncError}</Text> : null}
          <Pressable onPress={runSync} disabled={syncing} style={[styles.primaryButton, syncing && styles.disabledButton]}><Text style={styles.primaryButtonText}>{syncing ? 'SYNCING…' : 'SYNC NOW'}</Text></Pressable>
        </View>
        <Text style={styles.mapInstruction}>Your courses, rounds and bag sync automatically when the app opens and shortly after changes. Published courses and shared rounds are public; everything else is private to your account.</Text>
        <Pressable onPress={confirmSignOut} style={styles.endSessionButton}><Text style={styles.undoText}>SIGN OUT</Text></Pressable>
        <Pressable onPress={confirmDeleteAccount} style={styles.endSessionButton}><Text style={styles.endSessionText}>DELETE ACCOUNT</Text></Pressable>
      </> : <>
        <View style={styles.menuIntro}>
          <Text style={styles.menuIntroLabel}>BACK UP AND SHARE</Text>
          <Text style={styles.menuIntroCopy}>Sign in to back up your courses, rounds and bag, keep them in sync across devices, publish courses to the directory, and share rounds. Glide Path keeps working offline and syncs when you’re back online.</Text>
        </View>
        {syncError ? <Text style={styles.authError}>{syncError}</Text> : null}
        {authMode === 'signIn' || authMode === 'register' ? <View style={[styles.typeRow, styles.authTabs]}>
          {(['signIn', 'register'] as const).map((item) => <Pressable key={item} onPress={() => switchAuthMode(item)} style={[styles.typeButton, styles.sheetTypeButton, authMode === item && styles.typeButtonSelected]}><Text style={[styles.typeText, authMode === item && styles.typeTextSelected]}>{item === 'signIn' ? 'Sign in' : 'Create account'}</Text></Pressable>)}
        </View> : <Pressable onPress={() => switchAuthMode('signIn')} style={styles.backLink}><Text style={styles.homeButtonText}>‹ BACK TO SIGN IN</Text></Pressable>}
        <View style={styles.builderPanel}>
          {authMode === 'forgot' && <Text style={styles.authIntro}>Enter your account’s email and we’ll send a code to reset your password.</Text>}
          {authNotice ? <Text style={styles.authNotice}>{authNotice}</Text> : null}
          {authMode === 'register' && <>
            <Text style={styles.builderLabel}>NAME</Text>
            <TextInput value={authName} onChangeText={setAuthName} placeholder="Shown on courses you publish" placeholderTextColor="#5f6a63" style={styles.builderInput} textContentType="name" autoComplete="name" />
          </>}
          <Text style={[styles.builderLabel, authMode === 'register' && styles.detailLabel]}>EMAIL</Text>
          <TextInput value={authEmail} onChangeText={setAuthEmail} placeholder="you@example.com" placeholderTextColor="#5f6a63" style={styles.builderInput} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" autoComplete="email" />
          {authMode === 'reset' && <>
            <Text style={[styles.builderLabel, styles.detailLabel]}>CODE FROM THE EMAIL</Text>
            <TextInput value={resetCode} onChangeText={(text) => setResetCode(text.replace(/[^0-9]/g, '').slice(0, 6))} placeholder="6 digits" placeholderTextColor="#5f6a63" style={[styles.builderInput, styles.codeInput]} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} />
          </>}
          {authMode !== 'forgot' && <>
            <Text style={[styles.builderLabel, styles.detailLabel]}>{authMode === 'reset' ? 'NEW PASSWORD' : 'PASSWORD'}</Text>
            <TextInput value={authPassword} onChangeText={setAuthPassword} onSubmitEditing={submitAuth} placeholder={authMode === 'signIn' ? 'Password' : 'At least 8 characters'} placeholderTextColor="#5f6a63" style={styles.builderInput} secureTextEntry textContentType={authMode === 'signIn' ? 'password' : 'newPassword'} autoComplete={authMode === 'signIn' ? 'current-password' : 'new-password'} returnKeyType="go" />
          </>}
          {authError ? <Text style={styles.authError}>{authError}</Text> : null}
          <Pressable onPress={submitAuth} disabled={authBusy} style={[styles.primaryButton, authBusy && styles.disabledButton]}><Text style={styles.primaryButtonText}>{authBusy ? 'PLEASE WAIT…' : { signIn: 'SIGN IN', register: 'CREATE ACCOUNT', forgot: 'SEND RESET CODE', reset: 'RESET PASSWORD & SIGN IN' }[authMode]}</Text></Pressable>
          {authBusy && <Text style={styles.builderHint}>The server can take up to a minute to wake if it hasn’t been used recently.</Text>}
          {authMode === 'signIn' && <Pressable onPress={() => switchAuthMode('forgot')} style={styles.textLink}><Text style={styles.textLinkText}>Forgot password?</Text></Pressable>}
          {authMode === 'reset' && <Pressable onPress={sendResetCode} disabled={authBusy} style={styles.textLink}><Text style={styles.textLinkText}>Send a new code</Text></Pressable>}
        </View>
        <Text style={styles.builderFootnote}>Your existing courses, rounds and bag upload the first time you sign in.</Text>
      </>}
      <Text style={styles.serverNote}>SERVER · {API_URL.replace(/^https?:\/\//, '')}</Text>
    </ScrollView>
  </>;
};
