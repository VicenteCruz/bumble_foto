// analyzer.js

const ImageAnalyzer = {
  // Configuráveis - os valores ideais podem variar conforme a câmara
  BLUR_THRESHOLD: 80, // Variância laplaciana abaixo disto = Desfocada
  UNDER_EXPOSED_THRESHOLD: 50, // Luminância média abaixo disto = Subexposta
  OVER_EXPOSED_THRESHOLD: 215, // Luminância média acima disto = Sobrexposta
  SAMPLE_SIZE: 500, // Tamanho máximo da amostra no canvas (maior para preservar arestas)

  /**
   * Avalia a qualidade de um elemento <img> usando algoritmos matemáticos simples.
   * Retorna uma promise que resolve num array de tags.
   */
  async analyze(imgElement) {
    if (!imgElement || !imgElement.complete || imgElement.naturalWidth === 0) {
      return [];
    }

    const tags = [];
    
    // Canvas invisível para tirar uma amostra da imagem
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // Manter as proporções mas limitar o tamanho para máxima performance
    let width = imgElement.naturalWidth;
    let height = imgElement.naturalHeight;
    const maxDim = this.SAMPLE_SIZE;
    
    if (width > maxDim || height > maxDim) {
      if (width > height) {
        height = Math.round((height * maxDim) / width);
        width = maxDim;
      } else {
        width = Math.round((width * maxDim) / height);
        height = maxDim;
      }
    }
    
    canvas.width = width;
    canvas.height = height;
    
    // Desenhar amostra
    ctx.drawImage(imgElement, 0, 0, width, height);
    
    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, width, height);
    } catch (e) {
      return []; // Protecção caso o canvas fique tainted (problemas CORS não devem acontecer aqui)
    }
    
    const data = imageData.data;
    const len = data.length;
    
    // 1. Calcular a média de luz da imagem inteira (Grayscale)
    let totalLuminance = 0;
    const grayscalePixels = new Uint8ClampedArray(width * height);
    
    let j = 0;
    for (let i = 0; i < len; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // Fórmula perceptiva de luminosidade
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      totalLuminance += lum;
      grayscalePixels[j++] = lum;
    }
    
    const avgLuminance = totalLuminance / (width * height);
    
    const underExposed = window.AppSettings?.darkThreshold || this.UNDER_EXPOSED_THRESHOLD;
    const overExposed = window.AppSettings?.brightThreshold || this.OVER_EXPOSED_THRESHOLD;

    if (avgLuminance < underExposed) {
      tags.push({ type: 'dark', text: 'Escura', icon: '🌑' });
    } else if (avgLuminance > overExposed) {
      tags.push({ type: 'bright', text: 'Estourada', icon: '☀️' });
    }
    
    // 2. Variância Laplaciana (Detecção de Desfocagem)
    // Corre um kernel 3x3 para detectar arestas
    let sumLaplacian = 0;
    const lapCount = (width - 2) * (height - 2);
    if (lapCount <= 0) return tags;

    const laplacianValues = new Float32Array(lapCount);
    let lapIndex = 0;
    
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const top = grayscalePixels[(y - 1) * width + x];
        const bottom = grayscalePixels[(y + 1) * width + x];
        const left = grayscalePixels[y * width + (x - 1)];
        const right = grayscalePixels[y * width + (x + 1)];
        const center = grayscalePixels[y * width + x];
        
        // Kernel de Laplace: soma vizinhos - 4*centro
        const lap = top + bottom + left + right - 4 * center;
        laplacianValues[lapIndex++] = lap;
        sumLaplacian += lap;
      }
    }
    
    const avgLaplacian = sumLaplacian / lapCount;
    
    let variance = 0;
    for (let i = 0; i < lapCount; i++) {
      const diff = laplacianValues[i] - avgLaplacian;
      variance += diff * diff;
    }
    variance /= lapCount;
    
    const blurThresh = window.AppSettings?.blurThreshold || this.BLUR_THRESHOLD;
    if (variance < blurThresh && variance > 0) {
      tags.push({ type: 'blur', text: 'Desfocada', icon: '🌫️' });
    }
    
    return tags;
  },

  /**
   * Computes a 64-bit Difference Hash (dHash) for an image.
   * Very fast, ignores color and small brightness changes.
   */
  async computeDHash(imgElement) {
    if (!imgElement || !imgElement.complete || imgElement.naturalWidth === 0) return null;
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // 9x8 grid = 8 rows of 9 pixels.
    canvas.width = 9;
    canvas.height = 8;
    
    ctx.drawImage(imgElement, 0, 0, 9, 8);
    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, 9, 8);
    } catch (e) {
      return null;
    }
    
    const data = imageData.data;
    const grays = new Uint8Array(72);
    
    let j = 0;
    for (let i = 0; i < data.length; i += 4) {
      grays[j++] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    
    let hash = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const leftPixel = grays[row * 9 + col];
        const rightPixel = grays[row * 9 + (col + 1)];
        hash += leftPixel > rightPixel ? '1' : '0';
      }
    }
    
    return hash;
  },

  /**
   * Compare two dHashes and return the similarity percentage (0-100).
   */
  compareHashes(hash1, hash2) {
    if (!hash1 || !hash2 || hash1.length !== 64 || hash2.length !== 64) return 0;
    
    let difference = 0;
    for (let i = 0; i < 64; i++) {
      if (hash1[i] !== hash2[i]) {
        difference++;
      }
    }
    
    return ((64 - difference) / 64) * 100;
  },

  /**
   * Computes a 64-bin 3D Color Histogram.
   * Useful for detecting similarity regardless of scale/zoom.
   */
  async computeColorHistogram(imgElement) {
    if (!imgElement || !imgElement.complete || imgElement.naturalWidth === 0) return null;
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // 64x64 is plenty to get a reliable color distribution
    canvas.width = 64;
    canvas.height = 64;
    
    ctx.drawImage(imgElement, 0, 0, 64, 64);
    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, 64, 64);
    } catch (e) {
      return null;
    }
    
    const data = imageData.data;
    const histogram = new Float32Array(64);
    
    let totalPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue; // Ignore transparent
      
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // Quantize to 4 levels per channel (4x4x4 = 64 bins)
      const rBin = Math.floor(r / 64);
      const gBin = Math.floor(g / 64);
      const bBin = Math.floor(b / 64);
      
      const binIndex = (rBin << 4) | (gBin << 2) | bBin;
      histogram[binIndex]++;
      totalPixels++;
    }
    
    if (totalPixels > 0) {
      for (let i = 0; i < 64; i++) {
        histogram[i] /= totalPixels;
      }
    }
    
    return histogram;
  },

  /**
   * Compare two color histograms using Histogram Intersection.
   * Returns a percentage (0-100).
   */
  compareHistograms(hist1, hist2) {
    if (!hist1 || !hist2 || hist1.length !== 64 || hist2.length !== 64) return 0;
    
    let intersection = 0;
    for (let i = 0; i < 64; i++) {
      intersection += Math.min(hist1[i], hist2[i]);
    }
    
    return intersection * 100;
  }
};
