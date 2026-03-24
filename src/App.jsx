import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import {
  ContactShadows,
  Environment,
  Float,
  Html,
  MeshTransmissionMaterial,
  OrbitControls,
  PerspectiveCamera,
  useGLTF
} from '@react-three/drei'
import { Box3, Color, MathUtils, Vector3 } from 'three'
import { motion, useMotionValue, useScroll, useSpring, useTransform } from 'framer-motion'
import JSZip from 'jszip'

const DEFAULT_ACCENT = '#8c0910'
const DEFAULT_MODEL_SOURCE = {
  id: 'default-model',
  url: '/models/concept-car.glb',
  name: 'concept-car.glb',
  cleanupUrls: []
}
const DEFAULT_MODEL_TITLE = '2020 Alfa Romeo 8C-R Tazio Concept'

function toRgbTriplet(color) {
  return `${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}`
}

function createAccentTheme(accentValue) {
  const accent = new Color(accentValue)
  const accentHsl = { h: 0, s: 0, l: 0 }
  accent.getHSL(accentHsl)

  const complementHue = (accentHsl.h + 0.5) % 1
  const shadow = new Color().setHSL(accentHsl.h, Math.max(0.18, accentHsl.s * 0.48), 0.03)
  const deep = new Color().setHSL(accentHsl.h, Math.max(0.28, accentHsl.s * 0.62), 0.1)
  const mid = new Color().setHSL(accentHsl.h, Math.max(0.32, accentHsl.s * 0.72), Math.max(0.18, accentHsl.l * 0.5))
  const glow = new Color().setHSL(accentHsl.h, Math.max(0.24, accentHsl.s * 0.52), Math.min(0.68, accentHsl.l + 0.18))
  const overlay = new Color().setHSL(complementHue, Math.max(0.08, accentHsl.s * 0.18), 0.84)

  return {
    accent: toRgbTriplet(accent),
    shadow: toRgbTriplet(shadow),
    deep: toRgbTriplet(deep),
    mid: toRgbTriplet(mid),
    glow: toRgbTriplet(glow),
    overlay: toRgbTriplet(overlay)
  }
}

function scoreAccentColor(color) {
  const hsl = { h: 0, s: 0, l: 0 }
  color.getHSL(hsl)

  return {
    color,
    saturatedScore: hsl.s * (1 - Math.abs(hsl.l - 0.52)),
    isUsable: !(hsl.s < 0.12 || hsl.l < 0.08 || hsl.l > 0.9)
  }
}

function getImageSource(image) {
  if (!image) {
    return null
  }

  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
    return image
  }

  if (image instanceof HTMLImageElement || image instanceof HTMLCanvasElement || image instanceof OffscreenCanvas) {
    return image
  }

  if (image.data && image.width && image.height) {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }

    const imageData = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)
    context.putImageData(imageData, 0, 0)
    return canvas
  }

  return null
}

function sampleColorFromTexture(texture) {
  const source = getImageSource(texture?.image)
  if (!source) {
    return null
  }

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return null
  }

  const sampleSize = 24
  canvas.width = sampleSize
  canvas.height = sampleSize
  context.drawImage(source, 0, 0, sampleSize, sampleSize)

  const { data } = context.getImageData(0, 0, sampleSize, sampleSize)
  let red = 0
  let green = 0
  let blue = 0
  let total = 0

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] / 255
    if (alpha < 0.2) {
      continue
    }

    red += data[index] * alpha
    green += data[index + 1] * alpha
    blue += data[index + 2] * alpha
    total += alpha
  }

  if (!total) {
    return null
  }

  return new Color(red / (255 * total), green / (255 * total), blue / (255 * total))
}

async function inferAccentFromScene(scene) {
  let selected = null
  let selectedScore = 0
  let fallback = null
  let fallbackScore = 0

  const materials = []
  scene.traverse((child) => {
    if (!child.isMesh) {
      return
    }

    const meshMaterials = Array.isArray(child.material) ? child.material : [child.material]
    meshMaterials.forEach((material) => {
      if (material) {
        materials.push(material)
      }
    })
  })

  for (const material of materials) {
    const candidates = []

    if (material.map) {
      const sampledColor = sampleColorFromTexture(material.map)
      if (sampledColor) {
        candidates.push(sampledColor)
      }
    }

    if (material.color) {
      candidates.push(material.color.clone())
    }

    for (const candidate of candidates) {
      const { saturatedScore, isUsable } = scoreAccentColor(candidate)

      if (saturatedScore > fallbackScore) {
        fallback = candidate
        fallbackScore = saturatedScore
      }

      if (isUsable && saturatedScore > selectedScore) {
        selected = candidate
        selectedScore = saturatedScore
      }
    }
  }

  if (selected) {
    return `#${selected.getHexString()}`
  }

  if (fallback && fallbackScore > 0.08) {
    return `#${fallback.getHexString()}`
  }

  return DEFAULT_ACCENT
}

function formatModelTitle(name) {
  const withoutExtension = name.replace(/\.[^/.]+$/, '')
  const cleaned = withoutExtension
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) {
    return DEFAULT_MODEL_TITLE
  }

  return cleaned
    .split(' ')
    .map((word) => {
      if (/^\d/.test(word) || /^[A-Z0-9.-]+$/.test(word)) {
        return word
      }

      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

function createWikipediaSearchCandidates(modelTitle) {
  const base = modelTitle
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\bver(?:sion)?\.?\s*\d+\b/gi, ' ')
    .replace(/\b(v\d+|mk\d+)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const removableTerms = [
    'lbworks',
    'liberty walk',
    'widebody',
    'bodykit',
    'concept',
    'nic',
    'edition'
  ]

  const cleaned = removableTerms.reduce(
    (value, term) => value.replace(new RegExp(`\\b${term.replace(' ', '\\s+')}\\b`, 'gi'), ' '),
    base
  ).replace(/\s+/g, ' ').trim()

  const candidates = [modelTitle, base, cleaned]

  const supraMatch = cleaned.match(/\btoyota\s+supra\b/i)
  if (supraMatch) {
    candidates.push('Toyota Supra')
  }

  const bmwMatch = cleaned.match(/\bbmw\s+m\d\b/i)
  if (bmwMatch) {
    candidates.push(bmwMatch[0].toUpperCase().replace(/\s+/g, ' '))
  }

  return [...new Set(candidates.filter(Boolean))]
}

function normalizeAssetPath(path) {
  return path.replaceAll('\\', '/').replace(/^\.?\//, '').replace(/\/{2,}/g, '/')
}

function getBaseName(path) {
  const normalized = normalizeAssetPath(path)
  const parts = normalized.split('/')
  return parts[parts.length - 1]
}

function getDirectoryName(path) {
  const normalized = normalizeAssetPath(path)
  const index = normalized.lastIndexOf('/')
  return index === -1 ? '' : normalized.slice(0, index)
}

function resolveRelativePath(fromPath, requestPath) {
  const baseParts = getDirectoryName(fromPath).split('/').filter(Boolean)
  const requestParts = normalizeAssetPath(requestPath).split('/').filter(Boolean)
  const resolved = [...baseParts]

  requestParts.forEach((part) => {
    if (part === '.') {
      return
    }

    if (part === '..') {
      resolved.pop()
      return
    }

    resolved.push(part)
  })

  return resolved.join('/')
}

function getMimeType(path) {
  const extension = getBaseName(path).split('.').pop()?.toLowerCase()

  switch (extension) {
    case 'gltf':
      return 'model/gltf+json'
    case 'glb':
      return 'model/gltf-binary'
    case 'bin':
      return 'application/octet-stream'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'ktx2':
      return 'image/ktx2'
    default:
      return 'application/octet-stream'
  }
}

async function collectZipEntries(zip) {
  const entries = []
  const files = Object.values(zip.files)

  for (const entry of files) {
    if (entry.dir) {
      continue
    }

    if (entry.name.toLowerCase().endsWith('.zip')) {
      const nested = await JSZip.loadAsync(await entry.async('arraybuffer'))
      const nestedEntries = await collectZipEntries(nested)
      entries.push(...nestedEntries)
      continue
    }

    entries.push(entry)
  }

  return entries
}

async function createModelSourceFromZip(file) {
  const zip = await JSZip.loadAsync(file)
  const entries = await collectZipEntries(zip)
  const glbEntry = entries.find((entry) => entry.name.toLowerCase().endsWith('.glb'))

  if (glbEntry) {
    const blob = new Blob([await glbEntry.async('arraybuffer')], { type: 'model/gltf-binary' })
    const url = URL.createObjectURL(blob)

    return {
      id: `${file.name}-${crypto.randomUUID()}`,
      url,
      name: getBaseName(glbEntry.name),
      cleanupUrls: [url]
    }
  }

  const gltfEntries = entries
    .filter((entry) => entry.name.toLowerCase().endsWith('.gltf'))
    .sort((left, right) => left.name.length - right.name.length)

  if (gltfEntries.length === 0) {
    throw new Error('Zip does not contain a .glb or .gltf file.')
  }

  const gltfEntry = gltfEntries[0]
  const assetMap = {}
  const cleanupUrls = []

  for (const entry of entries) {
    const path = normalizeAssetPath(entry.name)
    const blob = new Blob([await entry.async('arraybuffer')], { type: getMimeType(path) })
    const url = URL.createObjectURL(blob)
    cleanupUrls.push(url)
    assetMap[path] = url
    assetMap[getBaseName(path)] = assetMap[getBaseName(path)] ?? url
  }

  return {
    id: `${file.name}-${crypto.randomUUID()}`,
    url: assetMap[normalizeAssetPath(gltfEntry.name)],
    name: file.name,
    gltfPath: normalizeAssetPath(gltfEntry.name),
    assetMap,
    cleanupUrls
  }
}

async function createModelSource(file) {
  if (file.name.toLowerCase().endsWith('.zip')) {
    return createModelSourceFromZip(file)
  }

  const url = URL.createObjectURL(file)
  return {
    id: `${file.name}-${crypto.randomUUID()}`,
    url,
    name: file.name,
    cleanupUrls: [url]
  }
}

function resolveAssetUrl(requestPath, source) {
  if (!source.assetMap || !source.gltfPath) {
    return requestPath
  }

  if (/^(blob:|data:|https?:)/i.test(requestPath)) {
    return requestPath
  }

  const normalizedRequest = normalizeAssetPath(requestPath)
  const resolvedPath = resolveRelativePath(source.gltfPath, requestPath)

  return (
    source.assetMap[resolvedPath] ||
    source.assetMap[normalizedRequest] ||
    source.assetMap[getBaseName(normalizedRequest)] ||
    requestPath
  )
}

const VIEW_PRESETS = [
  {
    label: 'Side Profile',
    headline: 'The silhouette arrives first.',
    body: 'Upload a `.glb` or `.gltf` file and the car settles into a cinematic side view before the scroll takes over.',
    camera: [9.2, 2.1, 1.9],
    target: [0, 0.95, 0],
    rotation: [0, Math.PI * 0.14, 0],
    accent: 'left'
  },
  {
    label: 'Top View',
    headline: 'Scroll pulls the machine overhead.',
    body: 'As the page advances, the camera arcs upward to expose roofline, surfacing, and wheel stance in one controlled move.',
    camera: [0.35, 11.2, 4.1],
    target: [0, 0.35, 0],
    rotation: [-0.28, Math.PI * 0.02, 0],
    accent: 'right'
  },
  {
    label: 'Front View',
    headline: 'The final stop is confrontation.',
    body: 'One more scroll transition rotates the stage into a head-on front view, ready for launch messaging or CTA content.',
    camera: [0.25, 2.2, 9.5],
    target: [0, 1.1, 0],
    rotation: [0, -Math.PI * 0.04, 0],
    accent: 'left'
  }
]

const DEFAULT_STORY_CONTENT = [
  {
    label: 'Powertrain',
    headline: 'Engine And Output',
    body: 'Upload a car model to pull its engine layout, power output, and torque figures from Wikipedia.'
  },
  {
    label: 'Performance',
    headline: 'Speed And Mass',
    body: 'The middle panel will update with top speed and weight information when a recognisable model page is found.'
  },
  {
    label: 'Build',
    headline: 'Maker And Years',
    body: 'Manufacturer and production year details will appear here for the uploaded model when Wikipedia provides them.'
  }
]

function cleanWikipediaText(text) {
  return text
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim()
}

function compactHeadline(text, fallback) {
  const cleaned = cleanWikipediaText(text)
  if (!cleaned) {
    return fallback
  }

  const words = cleaned.split(' ').slice(0, 6)
  const headline = words.join(' ').replace(/[.,;:!?]+$/, '')
  return headline.charAt(0).toUpperCase() + headline.slice(1)
}

function extractInfoboxData(html) {
  const parser = new DOMParser()
  const document = parser.parseFromString(html, 'text/html')
  const infobox = document.querySelector('.infobox')

  if (!infobox) {
    return {}
  }

  const rows = [...infobox.querySelectorAll('tr')]
  const values = {}

  rows.forEach((row) => {
    const header = row.querySelector('th')
    const cell = row.querySelector('td')

    if (!header || !cell) {
      return
    }

    const label = cleanWikipediaText(header.textContent || '').toLowerCase()
    const value = cleanWikipediaText(cell.textContent || '')

    if (label && value) {
      values[label] = value
    }
  })

  return values
}

function pickSpecValue(specs, labels) {
  for (const label of labels) {
    const exact = specs[label]
    if (exact) {
      return exact
    }

    const match = Object.entries(specs).find(([key]) => key.includes(label))
    if (match) {
      return match[1]
    }
  }

  return null
}

function buildStoryContent(modelTitle, wikiTitle, specs) {
  const engine = pickSpecValue(specs, ['engine', 'powertrain'])
  const power = pickSpecValue(specs, ['power output', 'power'])
  const torque = pickSpecValue(specs, ['torque'])
  const topSpeed = pickSpecValue(specs, ['top speed'])
  const weight = pickSpecValue(specs, ['kerb weight', 'curb weight', 'weight'])
  const manufacturer = pickSpecValue(specs, ['manufacturer'])
  const production = pickSpecValue(specs, ['production', 'model years'])

  return [
    {
      label: 'Powertrain',
      headline: compactHeadline(engine || 'Engine And Output', 'Engine And Output'),
      body: `${wikiTitle}: ${engine || 'Engine data unavailable on the matched page.'} ${power ? `Power: ${power}.` : ''} ${torque ? `Torque: ${torque}.` : ''}`.trim()
    },
    {
      label: 'Performance',
      headline: compactHeadline(topSpeed || 'Speed And Mass', 'Speed And Mass'),
      body: `${topSpeed ? `Top speed: ${topSpeed}.` : 'Top speed not listed on the matched page.'} ${weight ? `Weight: ${weight}.` : 'Weight not listed on the matched page.'}`.trim()
    },
    {
      label: 'Build',
      headline: compactHeadline(manufacturer || modelTitle, 'Maker And Years'),
      body: `${manufacturer ? `Manufacturer: ${manufacturer}.` : 'Manufacturer data unavailable.'} ${production ? `Production: ${production}.` : 'Production years unavailable.'}`.trim()
    }
  ]
}

async function researchCarModel(modelTitle) {
  const candidates = createWikipediaSearchCandidates(modelTitle)

  for (const candidate of candidates) {
    const searchResponse = await fetch(
      `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(candidate)}&limit=5`
    )

    if (!searchResponse.ok) {
      continue
    }

    const searchData = await searchResponse.json()
    const pages = searchData.pages || []

    for (const page of pages) {
      const parseResponse = await fetch(
        `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page.title)}&prop=text&format=json&formatversion=2&redirects=1&origin=*`
      )

      if (!parseResponse.ok) {
        continue
      }

      const parseData = await parseResponse.json()
      const specs = extractInfoboxData(parseData.parse?.text || '')
      const hasUsefulSpecs =
        pickSpecValue(specs, ['engine', 'powertrain']) ||
        pickSpecValue(specs, ['power output', 'power']) ||
        pickSpecValue(specs, ['top speed']) ||
        pickSpecValue(specs, ['manufacturer'])

      if (hasUsefulSpecs) {
        return buildStoryContent(modelTitle, page.title || modelTitle, specs)
      }
    }
  }

  throw new Error(`No usable Wikipedia spec page found for ${modelTitle}`)
}

function CursorGlow() {
  const x = useMotionValue(typeof window === 'undefined' ? 0 : window.innerWidth / 2)
  const y = useMotionValue(typeof window === 'undefined' ? 0 : window.innerHeight / 2)
  const glowX = useSpring(x, { damping: 30, stiffness: 250 })
  const glowY = useSpring(y, { damping: 30, stiffness: 250 })

  useEffect(() => {
    const update = (event) => {
      x.set(event.clientX)
      y.set(event.clientY)
    }

    window.addEventListener('pointermove', update)
    return () => window.removeEventListener('pointermove', update)
  }, [x, y])

  return (
    <motion.div
      className="cursor-glow"
      style={{
        translateX: glowX,
        translateY: glowY
      }}
    />
  )
}

function useScrollProgress(containerRef) {
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end']
  })

  return useSpring(scrollYProgress, {
    damping: 30,
    stiffness: 110,
    mass: 0.24
  })
}

function easeInOutCubic(value) {
  if (value < 0.5) {
    return 4 * value * value * value
  }

  return 1 - Math.pow(-2 * value + 2, 3) / 2
}

function mixPreset(progress) {
  if (progress <= 0.5) {
    const local = easeInOutCubic(progress / 0.5)
    return interpolatePreset(VIEW_PRESETS[0], VIEW_PRESETS[1], local)
  }

  const local = easeInOutCubic((progress - 0.5) / 0.5)
  return interpolatePreset(VIEW_PRESETS[1], VIEW_PRESETS[2], local)
}

function interpolatePreset(from, to, alpha) {
  return {
    camera: from.camera.map((value, index) => MathUtils.lerp(value, to.camera[index], alpha)),
    target: from.target.map((value, index) => MathUtils.lerp(value, to.target[index], alpha)),
    rotation: from.rotation.map((value, index) => MathUtils.lerp(value, to.rotation[index], alpha))
  }
}

function FallbackCar({ progress }) {
  const shell = useRef(null)
  const canopy = useRef(null)
  const wheelOffsets = useMemo(
    () => [
      [-1.7, -0.55, 1.1],
      [1.7, -0.55, 1.1],
      [-1.7, -0.55, -1.1],
      [1.7, -0.55, -1.1]
    ],
    []
  )

  useFrame((_, delta) => {
    if (!shell.current || !canopy.current) {
      return
    }

    const preset = mixPreset(progress.get())
    const idleYaw = Math.sin(performance.now() * 0.00035) * 0.08
    shell.current.rotation.x = MathUtils.damp(shell.current.rotation.x, preset.rotation[0], 5, delta)
    shell.current.rotation.y = MathUtils.damp(shell.current.rotation.y, preset.rotation[1] + idleYaw, 5, delta)
    shell.current.rotation.z = MathUtils.damp(shell.current.rotation.z, preset.rotation[2], 5, delta)
    canopy.current.rotation.y = MathUtils.damp(
      canopy.current.rotation.y,
      (preset.rotation[1] + idleYaw) * 0.4,
      5,
      delta
    )
  })

  return (
    <Float rotationIntensity={0.15} floatIntensity={0.22}>
      <group ref={shell} position={[0, 0.6, 0]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[5.3, 1.1, 2.4]} />
          <MeshTransmissionMaterial
            color="#7f0000"
            transmission={0.12}
            roughness={0.18}
            thickness={0.6}
            clearcoat={1}
            clearcoatRoughness={0.1}
            metalness={0.4}
          />
        </mesh>
        <mesh ref={canopy} position={[0.35, 0.88, 0]} castShadow>
          <boxGeometry args={[2.1, 0.78, 1.9]} />
          <meshStandardMaterial color="#22090c" metalness={0.55} roughness={0.18} />
        </mesh>
        <mesh position={[-2.45, 0.06, 0]} castShadow>
          <boxGeometry args={[0.45, 0.72, 1.75]} />
          <meshStandardMaterial color="#4f0000" metalness={0.6} roughness={0.22} />
        </mesh>
        <mesh position={[2.45, 0.06, 0]} castShadow>
          <boxGeometry args={[0.45, 0.72, 1.75]} />
          <meshStandardMaterial color="#4f0000" metalness={0.6} roughness={0.22} />
        </mesh>
        {wheelOffsets.map((offset) => (
          <mesh key={offset.join('-')} position={offset} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[0.54, 0.54, 0.52, 32]} />
            <meshStandardMaterial color="#0f0f10" metalness={0.2} roughness={0.9} />
          </mesh>
        ))}
      </group>
    </Float>
  )
}

function UploadedCar({ source, progress, onAccentChange }) {
  const sceneRef = useRef(null)
  const { scene } = useGLTF(source.url, true, true, (loader) => {
    if (source.assetMap) {
      loader.manager.setURLModifier((requestPath) => resolveAssetUrl(requestPath, source))
    }
  })
  const normalizedScene = useMemo(() => {
    const cloned = scene.clone(true)
    const bounds = new Box3().setFromObject(cloned)
    const size = bounds.getSize(new Vector3())
    const center = bounds.getCenter(new Vector3())
    const maxDimension = Math.max(size.x, size.y, size.z) || 1
    const fitScale = 6.4 / maxDimension

    cloned.position.sub(center)
    cloned.position.multiplyScalar(fitScale)
    cloned.position.y += size.y * fitScale * 0.08
    cloned.scale.setScalar(fitScale)

    return cloned
  }, [scene])

  useEffect(() => {
    let cancelled = false

    async function updateAccent() {
      const accent = await inferAccentFromScene(scene)
      if (!cancelled) {
        onAccentChange(accent)
      }
    }

    updateAccent()

    return () => {
      cancelled = true
    }
  }, [scene, onAccentChange])

  useEffect(() => {
    normalizedScene.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true
        child.receiveShadow = true
      }
    })
  }, [normalizedScene])

  useFrame((_, delta) => {
    if (!sceneRef.current) {
      return
    }

    const preset = mixPreset(progress.get())
    const idleYaw = Math.sin(performance.now() * 0.00035) * 0.08
    sceneRef.current.rotation.x = MathUtils.damp(sceneRef.current.rotation.x, preset.rotation[0], 5, delta)
    sceneRef.current.rotation.y = MathUtils.damp(sceneRef.current.rotation.y, preset.rotation[1] + idleYaw, 5, delta)
    sceneRef.current.rotation.z = MathUtils.damp(sceneRef.current.rotation.z, preset.rotation[2], 5, delta)
  })

  return (
    <primitive
      ref={sceneRef}
      object={normalizedScene}
      position={[0, 0, 0]}
    />
  )
}

function SceneRig({ progress, modelSource, onAccentChange }) {
  const cameraRef = useRef(null)
  const controlsRef = useRef(null)
  const target = useRef(new Vector3(...VIEW_PRESETS[0].target))

  useFrame((_, delta) => {
    if (!cameraRef.current || !controlsRef.current) {
      return
    }

    const isHeroInteractive = progress.get() < 0.035
    controlsRef.current.enabled = isHeroInteractive

    if (isHeroInteractive) {
      controlsRef.current.update()
      return
    }

    const preset = mixPreset(progress.get())
    cameraRef.current.position.x = MathUtils.damp(cameraRef.current.position.x, preset.camera[0], 4, delta)
    cameraRef.current.position.y = MathUtils.damp(cameraRef.current.position.y, preset.camera[1], 4, delta)
    cameraRef.current.position.z = MathUtils.damp(cameraRef.current.position.z, preset.camera[2], 4, delta)

    target.current.x = MathUtils.damp(target.current.x, preset.target[0], 4, delta)
    target.current.y = MathUtils.damp(target.current.y, preset.target[1], 4, delta)
    target.current.z = MathUtils.damp(target.current.z, preset.target[2], 4, delta)
    controlsRef.current.target.copy(target.current)
    controlsRef.current.update()
    cameraRef.current.lookAt(target.current)
  })

  return (
    <>
      <PerspectiveCamera ref={cameraRef} makeDefault position={VIEW_PRESETS[0].camera} fov={42} />
      <ambientLight intensity={0.6} />
      <spotLight
        position={[8, 18, 10]}
        intensity={1.8}
        angle={0.35}
        penumbra={1}
        color="#ff6b57"
        castShadow
      />
      <pointLight position={[-8, 2, -10]} intensity={1.4} color="#c60018" />
      <Environment preset="city" />
      <Suspense
        fallback={
          <Html center className="loader">
            Loading model...
          </Html>
        }
      >
        {modelSource ? (
          <UploadedCar key={modelSource.id} source={modelSource} progress={progress} onAccentChange={onAccentChange} />
        ) : (
          <FallbackCar progress={progress} />
        )}
      </Suspense>
      <ContactShadows position={[0, -1.15, 0]} opacity={0.6} blur={2.8} scale={20} far={4.8} />
      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.08}
        enablePan={false}
        enableZoom={false}
        enableRotate
        minPolarAngle={Math.PI * 0.18}
        maxPolarAngle={Math.PI * 0.48}
        target={VIEW_PRESETS[0].target}
      />
    </>
  )
}

function StoryPanel({ id, index, preset, step }) {
  const opacity = useTransform(step, [index - 0.45, index, index + 0.45], [0.82, 1, 0.82])
  const y = useTransform(step, [index - 0.35, index, index + 0.35], [56, 0, -56])

  return (
    <section id={id} className={`story-panel ${preset.accent === 'right' ? 'align-right' : 'align-left'}`}>
      <motion.div className="story-copy" style={{ opacity, y }}>
        <span className="panel-index">0{index + 1}</span>
        <p className="panel-label">{preset.label}</p>
        <h2>{preset.headline}</h2>
        <p>{preset.body}</p>
      </motion.div>
    </section>
  )
}

function App() {
  const containerRef = useRef(null)
  const loopLockRef = useRef(false)
  const progress = useScrollProgress(containerRef)
  const step = useTransform(progress, [0, 0.33, 0.66, 1], [0, 1, 2, 2])
  const [modelSource, setModelSource] = useState(DEFAULT_MODEL_SOURCE)
  const [accentHex, setAccentHex] = useState(DEFAULT_ACCENT)
  const [fileName, setFileName] = useState(DEFAULT_MODEL_SOURCE.name)
  const [storyContent, setStoryContent] = useState(DEFAULT_STORY_CONTENT)
  const modelTitle = useMemo(() => formatModelTitle(fileName), [fileName])
  const accentTheme = useMemo(() => createAccentTheme(accentHex), [accentHex])
  const storyPanels = useMemo(
    () => VIEW_PRESETS.map((preset, index) => ({ ...preset, ...storyContent[index] })),
    [storyContent]
  )

  useEffect(() => {
    const root = document.documentElement
    const updatePointerLight = (event) => {
      root.style.setProperty('--pointer-x', `${event.clientX}px`)
      root.style.setProperty('--pointer-y', `${event.clientY}px`)
    }

    window.addEventListener('pointermove', updatePointerLight)
    root.style.setProperty('--accent-rgb', accentTheme.accent)
    root.style.setProperty('--accent-shadow-rgb', accentTheme.shadow)
    root.style.setProperty('--accent-deep-rgb', accentTheme.deep)
    root.style.setProperty('--accent-mid-rgb', accentTheme.mid)
    root.style.setProperty('--accent-glow-rgb', accentTheme.glow)
    root.style.setProperty('--accent-overlay-rgb', accentTheme.overlay)
    return () => {
      window.removeEventListener('pointermove', updatePointerLight)
    }
  }, [accentTheme])

  useEffect(() => {
    return () => {
      modelSource.cleanupUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [modelSource])

  useEffect(() => {
    const handleLoopScroll = () => {
      if (loopLockRef.current) {
        return
      }

      const scrollTop = window.scrollY
      const viewportHeight = window.innerHeight
      const documentHeight = document.documentElement.scrollHeight
      const loopThreshold = documentHeight - viewportHeight - 24

      if (scrollTop < loopThreshold) {
        return
      }

      loopLockRef.current = true
      window.scrollTo({ top: 0, behavior: 'auto' })

      window.setTimeout(() => {
        loopLockRef.current = false
      }, 180)
    }

    window.addEventListener('scroll', handleLoopScroll, { passive: true })

    return () => {
      window.removeEventListener('scroll', handleLoopScroll)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadStoryContent() {
      try {
        const researchedContent = await researchCarModel(modelTitle)
        if (!cancelled) {
          setStoryContent(researchedContent)
        }
      } catch (error) {
        console.error(error)
        if (!cancelled) {
          setStoryContent(DEFAULT_STORY_CONTENT)
        }
      }
    }

    loadStoryContent()

    return () => {
      cancelled = true
    }
  }, [modelTitle])

  const handleFileChange = async (event) => {
    const input = event.target
    const file = input.files?.[0]
    if (!file) {
      return
    }

    try {
      const nextSource = await createModelSource(file)
      setModelSource(nextSource)
      setFileName(nextSource.name)
    } catch (error) {
      console.error(error)
      setFileName(`Unsupported file: ${file.name}`)
    } finally {
      input.value = ''
    }
  }

  return (
    <div className="app-shell" ref={containerRef}>
      <CursorGlow />

      <header className="site-header">
        <a href="#" className="brand-mark">{modelTitle}</a>
        <nav className="site-nav">
          <a href="#side">Profile</a>
          <a href="#top">Aerial</a>
          <a href="#front">Front</a>
        </nav>
        <label className="upload-chip">
          <span>Upload Car</span>
          <input type="file" accept=".glb,.gltf,.zip,model/gltf-binary,model/gltf+json" onChange={handleFileChange} />
        </label>
      </header>

      <div className="noise-layer" />

      <div className="experience-shell">
        <div className="stage-stick">
          <div className="open-stage">
            <Canvas shadows dpr={[1, 2]}>
              <SceneRig progress={progress} modelSource={modelSource} onAccentChange={setAccentHex} />
            </Canvas>
          </div>
          <div className="hero-overlay">
            <h1>{modelTitle}</h1>
          </div>
        </div>

        <main className="story">
          {storyPanels.map((preset, index) => (
            <StoryPanel
              key={`${index}-${preset.label}`}
              id={index === 0 ? 'side' : index === 1 ? 'top' : 'front'}
              index={index}
              preset={preset}
              step={step}
            />
          ))}
        </main>
      </div>
    </div>
  )
}

export default App
