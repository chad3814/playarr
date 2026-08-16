import { useCallback, useState, type DragEvent, type JSX } from 'react';

interface Props {
  readonly onFile: (file: File) => void;
}

export function Dropzone({ onFile }: Props): JSX.Element {
  const [over, setOver] = useState(false);

  const drop = useCallback(
    (event: DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      setOver(false);
      const file = event.dataTransfer.files.item(0);
      if (file !== null) {
        onFile(file);
      }
    },
    [onFile],
  );

  return (
    <label
      className={over ? 'dropzone dropzone--over' : 'dropzone'}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <span>Drop an NZB file here, or choose one</span>
      <input
        type="file"
        accept=".nzb,application/x-nzb"
        aria-label="NZB file"
        onChange={(event) => {
          const file = event.target.files?.item(0);
          if (file !== null && file !== undefined) {
            onFile(file);
          }
        }}
      />
    </label>
  );
}
