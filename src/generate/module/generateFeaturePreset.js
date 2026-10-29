import { generateFeature } from './generateFeature.js';
export default function generateFeaturePreset(options = {}) {
    return generateFeature(options, true);
}
