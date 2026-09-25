import type { ExportFormat, SceneRecipeV2 } from './types'
import { WORLD_TYPE_SLUGS } from './worldParams'

type NamedRecipe = Pick<SceneRecipeV2, 'celestialType' | 'seed'>

export const SEQUENCE_FRAME_DIGITS = 4

export const exportBaseName = (recipe: NamedRecipe): string => `${WORLD_TYPE_SLUGS[recipe.celestialType]}-${recipe.seed}`

const FORMAT_SUFFIX: Record<ExportFormat, string> = {
    png: '',
    gif: '',
    'scene-package': '-scene',
    spritesheet: '-spritesheet',
    'png-sequence': '-frames',
}

/* Every format gets its own stem, so downloads of one body never overwrite each other. */
export const exportStem = (recipe: NamedRecipe, format: ExportFormat): string =>
    `${exportBaseName(recipe)}${FORMAT_SUFFIX[format]}`

export const exportExtension = (format: ExportFormat, includeMetadata = true): 'png' | 'gif' | 'zip' => {
    if (format === 'png') return 'png'
    if (format === 'gif') return 'gif'
    if (format === 'spritesheet' && !includeMetadata) return 'png'
    return 'zip'
}

export const exportMediaType = (extension: 'png' | 'gif' | 'zip'): string =>
    extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif' : 'application/zip'

export const exportFilename = (recipe: NamedRecipe, format: ExportFormat, includeMetadata = true): string =>
    `${exportStem(recipe, format)}.${exportExtension(format, includeMetadata)}`

export const sequenceFramePrefix = (recipe: NamedRecipe): string => `${exportStem(recipe, 'png-sequence')}-`

export const sequenceFrameFilename = (recipe: NamedRecipe, index: number): string =>
    `${sequenceFramePrefix(recipe)}${String(index + 1).padStart(SEQUENCE_FRAME_DIGITS, '0')}.png`
