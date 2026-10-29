import { generateFeature } from './generateFeature.js';
import type { FeatureOptions } from './generateFeature.js';
export default function generateFeaturePreset(options: FeatureOptions = {}): Promise<void> {
	return generateFeature(options, true);
}
