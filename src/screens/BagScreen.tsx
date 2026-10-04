import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { DiscInfo } from '../../lib/types';
import { styles } from '../theme';
import { DISC_SEARCH_MAX_RESULTS, DISC_SEARCH_MIN_CHARS, DISCIT_API_URL } from '../constants';
import { formatDiscMeta, formatFlightNumbers } from '../format';
import { ScreenHeading } from '../components/ScreenHeading';
import { useApp } from '../state/AppState';

export const BagScreen = () => {
  const { addCatalogDisc, addDisc, bag, bagDetails, bagWeights, deleteDisc, setDiscWeight, shots } = useApp();
  const [bagEntry, setBagEntry] = useState('');
  const [discSearch, setDiscSearch] = useState<{ query: string; results: DiscInfo[]; failed: boolean }>({ query: '', results: [], failed: false });

  // Search DiscIt as the user types, fetching only the matching discs.
  useEffect(() => {
    const query = bagEntry.trim();
    if (query.length < DISC_SEARCH_MIN_CHARS) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${DISCIT_API_URL}?name=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`DiscIt returned ${response.status}`);
        const results = (await response.json()) as DiscInfo[];
        const seen = new Set<string>();
        const unique = results.filter((item) => {
          const key = `${item.name}|${item.brand}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        setDiscSearch({ query, results: unique.slice(0, DISC_SEARCH_MAX_RESULTS), failed: false });
      } catch {
        if (controller.signal.aborted) return;
        setDiscSearch({ query, results: [], failed: true });
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [bagEntry]);

  const discQuery = bagEntry.trim();
  const discSearchPending = discSearch.query !== discQuery;
  const discResults = discSearchPending ? [] : discSearch.results;

  const addEnteredDisc = () => {
    if (addDisc(bagEntry)) setBagEntry('');
  };

  return <>
    <ScreenHeading eyebrow="YOUR DISCS" title="Bag builder." />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.builderPanel}>
        <Text style={styles.builderLabel}>ADD A DISC</Text>
        <View style={styles.addDiscRow}><TextInput value={bagEntry} onChangeText={setBagEntry} onSubmitEditing={addEnteredDisc} placeholder="Disc name or mold" placeholderTextColor="#5f6a63" style={[styles.builderInput, styles.discInput]} returnKeyType="done" /><Pressable onPress={addEnteredDisc} style={styles.addDiscButton}><Text style={styles.addDiscButtonText}>ADD</Text></Pressable></View>
        {discQuery.length >= DISC_SEARCH_MIN_CHARS && <View style={styles.discResults}>
          {discSearchPending ? <Text style={styles.discResultsNote}>Searching DiscIt…</Text>
            : discSearch.failed ? <Text style={styles.discResultsNote}>Could not reach DiscIt. Check your connection, or tap ADD to save this name.</Text>
            : !discResults.length ? <Text style={styles.discResultsNote}>No matches in DiscIt. Tap ADD to save this name as a custom disc.</Text>
            : discResults.map((item) => <Pressable key={item.id} onPress={() => { addCatalogDisc(item); setBagEntry(''); }} style={styles.discResult} accessibilityRole="button" accessibilityLabel={`Add ${item.brand} ${item.name}`}><View style={styles.discResultCopy}><Text style={styles.bagItemName}>{item.name}</Text><Text style={styles.bagItemMeta}>{item.brand} · {item.category}</Text></View><Text style={styles.discResultFlight}>{formatFlightNumbers(item)}</Text><Text style={styles.bagArrow}>＋</Text></Pressable>)}
          <Text style={styles.discResultsCredit}>FLIGHT NUMBERS FROM DISCIT API</Text>
        </View>}
      </View>
      <Text style={styles.builderSectionTitle}>Your bag · {bag.length} discs</Text>
      {!bag.length && <Text style={styles.mapInstruction}>Your bag is empty. Search for a disc above to add it.</Text>}
      {bag.map((item, index) => <View key={`${item}-${index}`} style={styles.bagItem}><View style={styles.bagItemSelect}><View style={[styles.discSwatch, { backgroundColor: bagDetails[item]?.background_color ?? ['#e08b48', '#619276', '#8ba4a0', '#d4d1c3'][index % 4] }]}><Text style={[styles.discSwatchText, bagDetails[item]?.color ? { color: bagDetails[item].color } : null]}>{item.charAt(0).toUpperCase()}</Text></View><View style={styles.bagItemCopy}><Text style={styles.bagItemName}>{item}</Text>{bagDetails[item] && <Text style={styles.bagItemMeta}>{formatDiscMeta(bagDetails[item])}</Text>}{shots.some((shot) => shot.disc === item) && <Text style={styles.bagItemMeta}>{shots.filter((shot) => shot.disc === item).length} throws logged</Text>}</View></View><View style={styles.weightField}><TextInput value={bagWeights[item] ? String(bagWeights[item]) : ''} onChangeText={(text) => setDiscWeight(item, text)} placeholder="—" placeholderTextColor="#5f6a63" keyboardType="number-pad" maxLength={3} style={styles.weightInput} accessibilityLabel={`Weight of ${item} in grams`} /><Text style={styles.weightUnit}>g</Text></View><Pressable onPress={() => deleteDisc(item)} accessibilityRole="button" accessibilityLabel={`Remove ${item} from bag`} style={styles.deleteButton}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable></View>)}
    </ScrollView>
  </>;
};
