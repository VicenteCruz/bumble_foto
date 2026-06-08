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
    
    if (avgLuminance < this.UNDER_EXPOSED_THRESHOLD) {
      tags.push({ type: 'dark', text: 'Escura', icon: '🌑' });
    } else if (avgLuminance > this.OVER_EXPOSED_THRESHOLD) {
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
    
    if (variance < this.BLUR_THRESHOLD && variance > 0) {
      tags.push({ type: 'blur', text: 'Desfocada', icon: '🌫️' });
    }
    
    return tags;
  }
};
