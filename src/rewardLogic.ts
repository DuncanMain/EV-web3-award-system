// Reward logic has been moved to rules-based system in src/config/awardRules.ts
// This maintains a simpler interface for backward compatibility

export { calculateAwardTokens as calculateReward } from './config/awardRules';