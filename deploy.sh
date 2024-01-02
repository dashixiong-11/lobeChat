#!/bin/bash

# Step 1: Run the build command
bun run build

# Check if bun run build was successful
if [ $? -ne 0 ]; then
    echo "Build failed, exiting script."
    exit 1
fi

# Step 2: Compress the .next folder
zip -r .next.zip .next

# Check if zip operation was successful
if [ $? -ne 0 ]; then
    echo "Zip operation failed, exiting script."
    exit 1
fi

# Step 3: Upload the .next.zip file to the cloud server
scp .next.zip root@47.92.246.224:/root/lobeChat

# Check if scp operation was successful
if [ $? -ne 0 ]; then
    echo "File upload failed, exiting script."
    exit 1
fi

echo "Script executed successfully."
