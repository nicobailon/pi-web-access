import * as ort from 'onnxruntime-node';

async function main() {
    console.log('Debugging ONNX tensor structure...');
    
    const session = await ort.InferenceSession.create('/home/john/.local/llm/models/onnx/model.onnx', {
        providers: ['CPUExecutionProvider'],
    });
    
    // Get model metadata
    console.log('Input names:', session.inputMetadata);
    console.log('Output names:', session.outputMetadata);
    
    // Create input tensor using ort.Tensor
    const inputIds = new ort.Tensor('int32', new Int32Array([101, 2054, 2003, 102]), [1, 4]);
    const attentionMask = new ort.Tensor('float32', new Float32Array([1, 1, 1, 1]), [1, 4]);
    
    console.log('Input tensor created:', inputIds);
    
    const outputs = await session.run({
        input_ids: inputIds,
        attention_mask: attentionMask,
    });
    
    console.log('Outputs:', Object.keys(outputs));
    const outputTensor = outputs[Object.keys(outputs)[0]];
    console.log('Output tensor type:', outputTensor.type);
    console.log('Output tensor dims:', outputTensor.dims);
    console.log('Output tensor data type:', outputTensor.data?.constructor?.name);
    
    if (outputTensor.data) {
        const data = outputTensor.data as Float32Array;
        console.log('Data length:', data.length);
        console.log('First 10 values:', Array.from(data).slice(0, 10));
    }
}

main().catch(console.error);
