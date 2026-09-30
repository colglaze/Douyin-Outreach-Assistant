import type { ProfileGender, WorkCoverText, WorkGenderEvidence, WorkGenderSuggestion, WorkSample } from '../types';

const SELF_DESCRIPTION = /(?:^|[\s，。！？:：,;；])(?:我|本人)(?:就是|是一名|是一个|是位|是个|是)(男生|女生|男人|女人|男性|女性)|\bI\s+am\s+(?:a\s+)?(man|woman|male|female)\b/giu;

function genderOf(word: string): ProfileGender {
  return /^(男生|男人|男性|man|male)$/i.test(word) ? 'MALE' : 'FEMALE';
}

/** 只提取第一人称的明确自述；结果是待核对线索，不是身份判定。 */
export function inferWorkGender(
  works: WorkSample[],
  transcript: string,
  coverTexts: WorkCoverText[] = [],
  coversChecked = 0,
  warning?: string,
): WorkGenderSuggestion {
  const evidence: WorkGenderEvidence[] = [];
  const genders = new Set<ProfileGender>();
  const add = (text: string, source: WorkGenderEvidence['source'], workUrl?: string) => {
    for (const match of text.matchAll(SELF_DESCRIPTION)) {
      const word = match[1] || match[2];
      if (!word) continue;
      genders.add(genderOf(word));
      if (evidence.length < 6) evidence.push({ source, text: match[0].trim(), workUrl });
    }
  };

  works.forEach((work) => add(work.caption, 'CAPTION', work.url));
  const trimmedTranscript = transcript.trim().slice(0, 1000);
  if (trimmedTranscript) add(trimmedTranscript, 'TRANSCRIPT');
  coverTexts.forEach(({ workIndex, text }) => {
    if (Number.isInteger(workIndex) && workIndex >= 0 && workIndex < works.length) {
      add(text.slice(0, 200), 'COVER', works[workIndex].url);
    }
  });

  const gender = genders.size === 1 ? [...genders][0] : 'UNKNOWN';
  const conflict = genders.size > 1 ? '作品线索相互矛盾，请人工核对。' : '';
  return {
    gender,
    evidence,
    worksChecked: works.length,
    coversChecked,
    transcriptUsed: !!trimmedTranscript,
    warning: [warning, conflict].filter(Boolean).join(' ') || undefined,
  };
}
