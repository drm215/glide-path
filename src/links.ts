import { Alert, Linking, Share } from 'react-native';

export const openLink = (url: string) => {
  Linking.openURL(url).catch(() => Alert.alert('Could not open link', url));
};

export const shareLink = (message: string, url: string) => {
  // The link goes in the message only; passing it as `url` too makes iOS share it twice.
  Share.share({ message: `${message} ${url}` }).catch(() => undefined);
};
