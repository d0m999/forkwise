import { OrganizeOutput } from './organize-contracts.js';

export const OrganizeCandidateOutput = OrganizeOutput.refine(output => output.candidate !== null || output.gaps.length > 0, {
  path: ['gaps'],
  message: '没有候选时须说明资料缺口',
});

export const ORGANIZE_PURPOSE = '把已授权的卡片文字整理成一张可读的候选卡。以自己的话重组结构，标明推断和资料缺口，只用传入文字，不补充外部事实或生成引用。无法整理时返回空候选并解释缺口。任务只返回候选，不改原卡，也不触发任何动作。';
